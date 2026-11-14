// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Минимальный мок USDT для тестов (18 decimals, как Binance-Peg USDT
// на BSC Mainnet). Только то, что нужно лотерее: approve/transferFrom.
contract TestUSDT {
    string public name = "Test USDT";
    string public symbol = "tUSDT";
    uint8 public decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "t: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "t: allowance");
        require(balanceOf[from] >= amount, "t: balance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}
