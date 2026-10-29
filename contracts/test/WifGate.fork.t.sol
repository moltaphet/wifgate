// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WifGate} from "../src/WifGate.sol";

interface IWIF {
    function balanceOf(address) external view returns (uint256);
    function approve(address, uint256) external returns (bool);
    function totalSupply() external view returns (uint256);
}

/// @notice Runs WifGate against the real $WIF on Robinhood Chain. Skipped unless RH_RPC_URL is set.
///         RH_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract Fork -vv
contract WifGateForkTest is Test {
    address internal constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;

    function test_fork_payBurnsRealWif() public {
        string memory rpc = vm.envOr("RH_RPC_URL", string(""));
        if (bytes(rpc).length == 0) vm.skip(true);
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 4663);

        WifGate gate = new WifGate(WIF);
        address payer = makeAddr("payer");
        address seller = makeAddr("seller");

        deal(WIF, payer, 1_000 ether);
        vm.prank(payer);
        IWIF(WIF).approve(address(gate), type(uint256).max);

        uint256 deadBefore = IWIF(WIF).balanceOf(gate.BURN_ADDRESS());
        uint256 supplyBefore = IWIF(WIF).totalSupply();

        vm.prank(payer);
        bytes32 id = gate.pay(seller, keccak256("fork"), keccak256("n"), 500 ether);

        assertEq(IWIF(WIF).balanceOf(gate.BURN_ADDRESS()) - deadBefore, 10 ether);
        assertEq(IWIF(WIF).balanceOf(seller), 490 ether);
        assertEq(IWIF(WIF).balanceOf(address(gate)), 0);
        assertEq(IWIF(WIF).totalSupply(), supplyBefore);
        assertTrue(gate.isPaid(id));
    }
}
