// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {WifGate} from "../src/WifGate.sol";

/**
 * Usage:
 *   source .env
 *   forge script script/Deploy.s.sol:DeployWifGate --rpc-url $RH_RPC_URL --broadcast --private-key $PRIVATE_KEY
 */
contract DeployWifGate is Script {
    /// @dev $WIF on Robinhood Chain (chain id 4663).
    address internal constant WIF = 0x5173b8eA6923c2d40267890D45C46a3480954773;

    function run() external returns (WifGate gate) {
        require(block.chainid == 4663, "run against Robinhood Chain mainnet (4663)");
        uint256 pk = vm.envUint("PRIVATE_KEY");

        console2.log("Deployer:", vm.addr(pk));
        vm.startBroadcast(pk);
        gate = new WifGate(WIF);
        vm.stopBroadcast();

        console2.log("WifGate deployed at:", address(gate));
    }
}
