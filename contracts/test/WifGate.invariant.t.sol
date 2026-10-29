// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {WifGate} from "../src/WifGate.sol";
import {MockWIF} from "./mocks/Tokens.sol";

contract GateHandler is Test {
    WifGate public gate;
    MockWIF public wif;
    address[] public payers;
    address[] public sellers;
    uint256 public ghostVolume;
    uint256 public ghostPayments;
    uint256 public nextNonce;

    constructor(WifGate g, MockWIF w) {
        gate = g;
        wif = w;
        for (uint256 i; i < 3; ++i) {
            address p = makeAddr(string.concat("payer", vm.toString(i)));
            address s = makeAddr(string.concat("seller", vm.toString(i)));
            payers.push(p);
            sellers.push(s);
            wif.mint(p, 1e30);
            vm.prank(p);
            wif.approve(address(g), type(uint256).max);
        }
    }

    function pay(uint256 pi, uint256 si, uint96 amount, bytes32 res) external {
        amount = uint96(bound(amount, 1, 1_000_000 ether));
        address p = payers[pi % payers.length];
        address s = sellers[si % sellers.length];
        vm.prank(p);
        gate.pay(s, res, bytes32(nextNonce++), amount);
        ghostVolume += amount;
        ghostPayments += 1;
    }
}

contract WifGateInvariantTest is Test {
    MockWIF internal wif;
    WifGate internal gate;
    GateHandler internal handler;

    function setUp() public {
        wif = new MockWIF();
        gate = new WifGate(address(wif));
        handler = new GateHandler(gate, wif);
        targetContract(address(handler));
    }

    function invariant_gateNeverHoldsTokens() public view {
        assertEq(wif.balanceOf(address(gate)), 0);
    }

    function invariant_statsMatchGhost() public view {
        assertEq(gate.totalVolume(), handler.ghostVolume());
        assertEq(gate.totalPayments(), handler.ghostPayments());
    }

    function invariant_burnedIsTwoPercentFloorSum() public view {
        assertLe(gate.totalBurned(), (gate.totalVolume() * 200) / 10_000);
        assertEq(wif.balanceOf(gate.BURN_ADDRESS()), gate.totalBurned());
    }

    function invariant_volumeEqualsSellerNetPlusBurn() public view {
        uint256 net;
        for (uint256 i; i < 3; ++i) {
            net += gate.sellerEarned(handler.sellers(i));
        }
        assertEq(net + gate.totalBurned(), gate.totalVolume());
    }
}
