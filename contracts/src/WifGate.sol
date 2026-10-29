// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Minimal ERC-20 surface WifGate needs.
interface IERC20Minimal {
    function transferFrom(address from, address to, uint256 value) external returns (bool);
}

/**
 * @title WifGate
 * @notice Settlement layer for pay-per-request APIs (HTTP 402) paid in $WIF on Robinhood Chain.
 *
 * A server answers an unpaid request with 402 and a payment challenge. The caller (a human with
 * a wallet, or an autonomous agent) calls {pay} once; the server verifies the {Paid} event and
 * serves the response. Every payment burns `BURN_BPS` of $WIF, so API traffic is a $WIF sink.
 *
 * Properties:
 *  - Non-custodial: `transferFrom` goes payer -> seller and payer -> burn address in one tx.
 *    The contract never holds tokens and has no owner, admin or upgrade path.
 *  - Unique receipts: `paymentId = keccak256(payer, payTo, resourceId, nonce)`. Including the
 *    payer means nobody can front-run or grief another payer's challenge by "using up" its nonce.
 *  - Challenge binding: `nonce` is chosen by the seller's server, `resourceId` names the route,
 *    so a payment made for one challenge cannot be redeemed for another.
 */
contract WifGate {
    /*//////////////////////////////////////////////////////////////
                                 TYPES
    //////////////////////////////////////////////////////////////*/

    /// @notice Stored proof that a payment happened.
    struct Receipt {
        /// @dev Gross amount paid (including the burned share).
        uint192 amount;
        /// @dev `block.timestamp` of the payment; 0 means "never paid".
        uint64 paidAt;
    }

    /*//////////////////////////////////////////////////////////////
                                 ERRORS
    //////////////////////////////////////////////////////////////*/

    error ZeroAmount();
    error AmountTooLarge();
    error InvalidPayTo();
    error InvalidToken();
    error AlreadyPaid();
    error TransferFailed();
    error Reentrancy();

    /*//////////////////////////////////////////////////////////////
                                 EVENTS
    //////////////////////////////////////////////////////////////*/

    /// @param paymentId Unique id, see {computePaymentId}.
    /// @param payer Wallet that paid (and must sign the access proof).
    /// @param payTo Seller that received `amount - burned`.
    /// @param resourceId Route identifier chosen by the seller.
    /// @param nonce Challenge nonce issued by the seller's server.
    /// @param amount Gross $WIF paid.
    /// @param burned Part of `amount` sent to the burn address.
    event Paid(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed payTo,
        bytes32 resourceId,
        bytes32 nonce,
        uint256 amount,
        uint256 burned
    );

    /*//////////////////////////////////////////////////////////////
                                STORAGE
    //////////////////////////////////////////////////////////////*/

    /// @notice The $WIF token.
    IERC20Minimal public immutable WIF;

    /// @notice Dead address that receives the burned share.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    /// @notice Share of every payment that is burned, in basis points (200 = 2%).
    uint256 public constant BURN_BPS = 200;

    uint256 public constant BPS_DENOMINATOR = 10_000;

    /// @notice Lifetime $WIF burned through this contract.
    uint256 public totalBurned;

    /// @notice Lifetime gross $WIF paid through this contract.
    uint256 public totalVolume;

    /// @notice Number of payments made.
    uint256 public totalPayments;

    /// @notice Lifetime net $WIF received by each seller.
    mapping(address => uint256) public sellerEarned;

    /// @notice Number of payments received by each seller.
    mapping(address => uint256) public sellerPayments;

    /// @notice Lifetime $WIF burned on behalf of each payer.
    mapping(address => uint256) public burnedBy;

    mapping(bytes32 => Receipt) private _receipts;

    uint256 private _locked = 1;

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(address wif) {
        if (wif == address(0) || wif.code.length == 0) revert InvalidToken();
        WIF = IERC20Minimal(wif);
    }

    /*//////////////////////////////////////////////////////////////
                                 PAY
    //////////////////////////////////////////////////////////////*/

    /**
     * @notice Pay a seller for one challenge. Needs a prior `approve(address(this), amount)`.
     * @param payTo Seller wallet that receives `amount` minus the burn.
     * @param resourceId Identifier of the paid route, chosen by the seller.
     * @param nonce Challenge nonce issued by the seller's server.
     * @param amount Gross $WIF to pay (18 decimals); `BURN_BPS` of it is burned.
     * @return paymentId Unique id of this payment.
     */
    function pay(address payTo, bytes32 resourceId, bytes32 nonce, uint256 amount)
        external
        nonReentrant
        returns (bytes32 paymentId)
    {
        if (amount == 0) revert ZeroAmount();
        if (amount > type(uint192).max) revert AmountTooLarge();
        if (payTo == address(0) || payTo == address(this) || payTo == BURN_ADDRESS) {
            revert InvalidPayTo();
        }

        paymentId = computePaymentId(msg.sender, payTo, resourceId, nonce);
        if (_receipts[paymentId].paidAt != 0) revert AlreadyPaid();

        uint256 burned = (amount * BURN_BPS) / BPS_DENOMINATOR;
        uint256 net = amount - burned;

        // Effects before interactions.
        _receipts[paymentId] = Receipt({amount: uint192(amount), paidAt: uint64(block.timestamp)});
        totalBurned += burned;
        totalVolume += amount;
        totalPayments += 1;
        sellerEarned[payTo] += net;
        sellerPayments[payTo] += 1;
        burnedBy[msg.sender] += burned;

        if (burned > 0) _pull(msg.sender, BURN_ADDRESS, burned);
        _pull(msg.sender, payTo, net);

        emit Paid(paymentId, msg.sender, payTo, resourceId, nonce, amount, burned);
    }

    /*//////////////////////////////////////////////////////////////
                                 VIEWS
    //////////////////////////////////////////////////////////////*/

    /// @notice Deterministic id for a (payer, seller, route, nonce) tuple.
    function computePaymentId(address payer, address payTo, bytes32 resourceId, bytes32 nonce)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(payer, payTo, resourceId, nonce));
    }

    /// @notice Receipt for a payment id; `paidAt == 0` if it was never paid.
    function receipts(bytes32 paymentId) external view returns (uint256 amount, uint256 paidAt) {
        Receipt memory r = _receipts[paymentId];
        return (r.amount, r.paidAt);
    }

    /// @notice Whether a payment id has been paid.
    function isPaid(bytes32 paymentId) external view returns (bool) {
        return _receipts[paymentId].paidAt != 0;
    }

    /*//////////////////////////////////////////////////////////////
                               INTERNALS
    //////////////////////////////////////////////////////////////*/

    /// @dev `transferFrom` that tolerates tokens returning no value and reverts on `false`.
    function _pull(address from, address to, uint256 value) private {
        (bool ok, bytes memory ret) =
            address(WIF).call(abi.encodeCall(IERC20Minimal.transferFrom, (from, to, value)));
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
