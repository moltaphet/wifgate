// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WifGate} from "../src/WifGate.sol";
import {MockWIF, FalseToken, NoReturnToken, ReentrantToken} from "./mocks/Tokens.sol";

contract WifGateTest is Test {
    event Paid(
        bytes32 indexed paymentId,
        address indexed payer,
        address indexed payTo,
        bytes32 resourceId,
        bytes32 nonce,
        uint256 amount,
        uint256 burned
    );

    MockWIF internal wif;
    WifGate internal gate;

    address internal payer = makeAddr("payer");
    address internal other = makeAddr("other");
    address internal seller = makeAddr("seller");
    address internal dead;

    bytes32 internal constant RES = keccak256("weather");
    bytes32 internal constant NONCE = keccak256("nonce-1");

    function setUp() public {
        wif = new MockWIF();
        gate = new WifGate(address(wif));
        dead = gate.BURN_ADDRESS();

        wif.mint(payer, 1_000_000 ether);
        wif.mint(other, 1_000_000 ether);
        vm.prank(payer);
        wif.approve(address(gate), type(uint256).max);
        vm.prank(other);
        wif.approve(address(gate), type(uint256).max);
    }

    /*//////////////////////////////////////////////////////////////
                                 PAY
    //////////////////////////////////////////////////////////////*/

    function test_pay_splitsBurnAndSeller() public {
        vm.prank(payer);
        bytes32 id = gate.pay(seller, RES, NONCE, 100 ether);

        assertEq(wif.balanceOf(dead), 2 ether, "2% burned");
        assertEq(wif.balanceOf(seller), 98 ether, "98% to seller");
        assertEq(wif.balanceOf(payer), 1_000_000 ether - 100 ether);
        assertEq(wif.balanceOf(address(gate)), 0, "never custodial");

        (uint256 amount, uint256 paidAt) = gate.receipts(id);
        assertEq(amount, 100 ether);
        assertEq(paidAt, block.timestamp);
        assertTrue(gate.isPaid(id));
    }

    function test_pay_emitsPaid() public {
        bytes32 id = gate.computePaymentId(payer, seller, RES, NONCE);
        vm.expectEmit(true, true, true, true, address(gate));
        emit Paid(id, payer, seller, RES, NONCE, 10 ether, 0.2 ether);

        vm.prank(payer);
        gate.pay(seller, RES, NONCE, 10 ether);
    }

    function test_pay_updatesStats() public {
        vm.prank(payer);
        gate.pay(seller, RES, NONCE, 100 ether);
        vm.prank(payer);
        gate.pay(seller, RES, keccak256("nonce-2"), 50 ether);

        assertEq(gate.totalVolume(), 150 ether);
        assertEq(gate.totalBurned(), 3 ether);
        assertEq(gate.totalPayments(), 2);
        assertEq(gate.sellerEarned(seller), 147 ether);
        assertEq(gate.sellerPayments(seller), 2);
        assertEq(gate.burnedBy(payer), 3 ether);
    }

    function test_pay_tinyAmountBurnsNothingButStillPays() public {
        vm.prank(payer);
        gate.pay(seller, RES, NONCE, 49); // 49 * 200 / 10_000 = 0
        assertEq(gate.totalBurned(), 0);
        assertEq(wif.balanceOf(seller), 49);
    }

    function test_computePaymentId_matchesAbiEncodeKeccak() public view {
        bytes32 expected = keccak256(abi.encode(payer, seller, RES, NONCE));
        assertEq(gate.computePaymentId(payer, seller, RES, NONCE), expected);
    }

    /*//////////////////////////////////////////////////////////////
                              UNIQUENESS
    //////////////////////////////////////////////////////////////*/

    function test_pay_revertsOnDoublePay() public {
        vm.prank(payer);
        gate.pay(seller, RES, NONCE, 1 ether);

        vm.prank(payer);
        vm.expectRevert(WifGate.AlreadyPaid.selector);
        gate.pay(seller, RES, NONCE, 1 ether);
    }

    /// @dev Someone else paying the same (seller, resource, nonce) must not block the real payer.
    function test_pay_otherPayerCannotGriefNonce() public {
        vm.prank(other);
        gate.pay(seller, RES, NONCE, 1); // attacker pays dust first

        vm.prank(payer);
        bytes32 id = gate.pay(seller, RES, NONCE, 5 ether); // victim still succeeds
        assertTrue(gate.isPaid(id));
        assertNotEq(id, gate.computePaymentId(other, seller, RES, NONCE));
    }

    function test_pay_sameNonceDifferentResourceOrSellerIsDistinct() public {
        vm.startPrank(payer);
        bytes32 a = gate.pay(seller, RES, NONCE, 1 ether);
        bytes32 b = gate.pay(seller, keccak256("other-route"), NONCE, 1 ether);
        bytes32 c = gate.pay(other, RES, NONCE, 1 ether);
        vm.stopPrank();
        assertTrue(a != b && b != c && a != c);
    }

    /*//////////////////////////////////////////////////////////////
                               REVERTS
    //////////////////////////////////////////////////////////////*/

    function test_pay_revertsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(WifGate.ZeroAmount.selector);
        gate.pay(seller, RES, NONCE, 0);
    }

    function test_pay_revertsAmountTooLarge() public {
        vm.prank(payer);
        vm.expectRevert(WifGate.AmountTooLarge.selector);
        gate.pay(seller, RES, NONCE, uint256(type(uint192).max) + 1);
    }

    function test_pay_revertsInvalidPayTo() public {
        vm.startPrank(payer);
        vm.expectRevert(WifGate.InvalidPayTo.selector);
        gate.pay(address(0), RES, NONCE, 1 ether);
        vm.expectRevert(WifGate.InvalidPayTo.selector);
        gate.pay(address(gate), RES, NONCE, 1 ether);
        vm.expectRevert(WifGate.InvalidPayTo.selector);
        gate.pay(dead, RES, NONCE, 1 ether);
        vm.stopPrank();
    }

    function test_pay_revertsWithoutAllowance() public {
        address broke = makeAddr("broke");
        wif.mint(broke, 10 ether);
        vm.prank(broke);
        vm.expectRevert();
        gate.pay(seller, RES, NONCE, 1 ether);
    }

    function test_pay_revertsWithoutBalance() public {
        address poor = makeAddr("poor");
        vm.prank(poor);
        wif.approve(address(gate), type(uint256).max);
        vm.prank(poor);
        vm.expectRevert();
        gate.pay(seller, RES, NONCE, 1 ether);
    }

    function test_failedPay_leavesNoReceipt() public {
        address poor = makeAddr("poor");
        vm.prank(poor);
        wif.approve(address(gate), type(uint256).max);
        bytes32 id = gate.computePaymentId(poor, seller, RES, NONCE);

        vm.prank(poor);
        vm.expectRevert();
        gate.pay(seller, RES, NONCE, 1 ether);

        assertFalse(gate.isPaid(id));
        assertEq(gate.totalPayments(), 0);
    }

    function test_constructor_revertsOnBadToken() public {
        vm.expectRevert(WifGate.InvalidToken.selector);
        new WifGate(address(0));
        vm.expectRevert(WifGate.InvalidToken.selector);
        new WifGate(makeAddr("eoa"));
    }

    /*//////////////////////////////////////////////////////////////
                         NON-STANDARD TOKENS
    //////////////////////////////////////////////////////////////*/

    function test_falseReturningToken_reverts() public {
        WifGate g = new WifGate(address(new FalseToken()));
        vm.expectRevert(WifGate.TransferFailed.selector);
        g.pay(seller, RES, NONCE, 1 ether);
    }

    function test_noReturnToken_works() public {
        NoReturnToken t = new NoReturnToken();
        WifGate g = new WifGate(address(t));
        t.mint(payer, 100 ether);
        vm.startPrank(payer);
        t.approve(address(g), 100 ether);
        g.pay(seller, RES, NONCE, 100 ether);
        vm.stopPrank();
        assertEq(t.balanceOf(seller), 98 ether);
        assertEq(t.balanceOf(g.BURN_ADDRESS()), 2 ether);
    }

    function test_reentrancyBlocked() public {
        ReentrantToken t = new ReentrantToken();
        WifGate g = new WifGate(address(t));
        t.setGate(address(g));
        t.mint(payer, 100 ether);
        vm.prank(payer);
        t.approve(address(g), type(uint256).max);

        // The re-entrant call is made by the token (msg.sender == token) and must fail.
        vm.prank(payer);
        g.pay(seller, RES, NONCE, 10 ether);

        assertTrue(t.attempted(), "token tried to re-enter");
        assertFalse(t.reentrySucceeded(), "re-entry was rejected");
        assertEq(bytes4(t.reentryError()), WifGate.Reentrancy.selector, "rejected by the guard");
        assertEq(g.totalPayments(), 1);
    }

    /*//////////////////////////////////////////////////////////////
                                 FUZZ
    //////////////////////////////////////////////////////////////*/

    function testFuzz_conservation(uint96 amount, bytes32 resourceId, bytes32 nonce) public {
        amount = uint96(bound(amount, 1, 1_000_000 ether));
        uint256 supply = wif.totalSupply();

        vm.prank(payer);
        gate.pay(seller, resourceId, nonce, amount);

        uint256 burned = (uint256(amount) * 200) / 10_000;
        assertEq(wif.balanceOf(dead), burned);
        assertEq(wif.balanceOf(seller), amount - burned);
        assertEq(wif.balanceOf(address(gate)), 0);
        assertEq(wif.totalSupply(), supply);
        assertEq(gate.totalBurned(), burned);
        assertEq(gate.totalVolume(), amount);
    }

    function testFuzz_paymentIdInjective(
        address p1,
        address p2,
        address s1,
        address s2,
        bytes32 r1,
        bytes32 r2,
        bytes32 n1,
        bytes32 n2
    ) public view {
        bytes32 a = gate.computePaymentId(p1, s1, r1, n1);
        bytes32 b = gate.computePaymentId(p2, s2, r2, n2);
        bool same = p1 == p2 && s1 == s2 && r1 == r2 && n1 == n2;
        assertEq(a == b, same);
    }
}
