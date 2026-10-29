// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @dev Bare-bones 18-decimals ERC-20 standing in for $WIF in tests.
contract MockWIF {
    string public constant name = "World Is Flat";
    string public constant symbol = "WIF";
    uint8 public constant decimals = 18;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 value) external {
        totalSupply += value;
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external virtual returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}

/// @dev Returns `false` instead of reverting (non-standard but seen in the wild).
contract FalseToken {
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}

/// @dev USDT-style: `transferFrom` returns nothing.
contract NoReturnToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function approve(address spender, uint256 value) external {
        allowance[msg.sender][spender] = value;
    }

    function transferFrom(address from, address to, uint256 value) external {
        allowance[from][msg.sender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }
}

interface IGatePay {
    function pay(address payTo, bytes32 resourceId, bytes32 nonce, uint256 amount)
        external
        returns (bytes32);
}

/// @dev Tries to re-enter `pay` from inside `transferFrom`.
contract ReentrantToken is MockWIF {
    IGatePay public gate;
    bool public attempted;
    bool public reentrySucceeded;
    bytes public reentryError;

    function setGate(address g) external {
        gate = IGatePay(g);
    }

    function transferFrom(address from, address to, uint256 value) external override returns (bool) {
        if (!attempted && address(gate) != address(0)) {
            attempted = true;
            try gate.pay(to, bytes32("re"), bytes32("entry"), 1) {
                reentrySucceeded = true;
            } catch (bytes memory err) {
                reentryError = err;
            }
        }
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        return true;
    }
}
