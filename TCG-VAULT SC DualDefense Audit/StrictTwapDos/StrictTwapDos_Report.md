# Strict TWAP Equality Validation Causes Protocol-Wide Denial of Service for EOAs

**Target:** `TCGVaultStakingVault.sol`
**Severity:** High
**Bug Category:** Denial of Service (DoS with unexpected revert)

## Description

In `TCGVaultStakingVault.sol`, the ERC4626 `deposit(uint256 assets, address receiver)` and `mint(uint256 shares, address receiver)` functions are overridden to enforce a strict mathematical equality check against a continuously sliding TWAP (Time-Weighted Average Price) threshold. 

This strict equality guarantees that normal staking transactions broadcasted by an Externally Owned Account (EOA), such as a user interacting via MetaMask, will almost always revert.

### Mathematical & Logical Proof

When a user attempts to stake by calling `deposit()`:
```solidity
    function deposit(uint256 assets, address receiver) public virtual override returns (uint256) {
        _maybeSlideTwapWindow(_basicNftPricingPair());
        uint256 shares = _sharesToStakeFor(receiver);
        uint256 expectedAssets = super.previewMint(shares);
        
        // Strict equality check
        if (assets != expectedAssets) revert InvalidVaultAmount(expectedAssets, assets);
        
        super.mint(shares, receiver);
        return shares;
    }
```

The core issue stems from `_sharesToStakeFor`, which queries `_currentRequiredStakeForBasicNFT()`. The required stake is calculated dynamically based on a TWAP over the last $dt$ seconds. This calculation is evaluated exactly at `block.timestamp`.

1. **Transaction Simulation (At $T_0$):** A user signs the transaction off-chain. Their frontend or wallet calls `maxDeposit(user)` to simulate the required `assets` exactly at the current timestamp ($T_0$).
2. **Transaction Execution (At $T_1$):** The transaction is mined by a validator e.g., 10-15 seconds later ($T_1$). `block.timestamp` has now increased. 
3. **TWAP Drift:** Because the spot price on PancakeSwap changes relative to the historical average, the internal accumulator (`avgPerSec`) drifts fractionally every second. Due to the ultra-high precision (Q112 arithmetic) used in `avgPerSec`, a 15-second change alters `avgPerSec`, causing `expectedAssets` to diverge by a few WEI from the user's simulated `assets`.
4. **Revert:** The contract enforces `if (assets != expectedAssets) revert InvalidVaultAmount;`. The transaction fails completely.

The same exact strict equality bug exists in the `mint(uint256 shares, address receiver)` function (`if (shares != expectedShares) revert;`).

## Impact
**Protocol-Wide Denial of Service.** 
Because an EOA user cannot predict the exact `block.timestamp` and precision-level TWAP value at the exact moment their transaction will be mined, they can never submit a successful staking transaction. The core feature of the Staking Vault is mathematically broken and completely unusable for end-users, fulfilling the definition of a permanent DoS. 
*(Note: This can only be bypassed if the user writes a custom proxy smart contract to dynamically fetch the amount within the same transaction, but TCG-VAULT does not provide such a proxy router).*

## Proof of Concept

1. Add the provided Hardhat test script `StrictTwapDos.test.ts` to your test suite.
2. The test simulates an environment where the TWAP window is active.
3. User A queries the required `assets` at $T_0$ and broadcasts a transaction.
4. Time advances by 15 seconds to simulate block mining delays.
5. The transaction is executed and reverts immediately with `InvalidVaultAmount`.

**Test Output:**
```text
	[+] DoS Confirmed!
	[+] Expected Assets at T_0 (Signed by user): 118747579034006366411
	[+] Expected Assets at T_1 (Mined block):    118747569153345676549
  TCGVaultStakingVault - Strict TWAP Equality DoS
    ✔ Should revert user's deposit transaction if mined a few seconds later due to TWAP movement (208ms)
```

## Recommended Mitigation

Remove the strict equality check (`!=`) in `deposit` and `mint`. 
Instead of forcing the user to pass the exact WEI amount dynamically:
1. Allow the user to specify a `maxAssets` they are willing to spend (slippage parameter) and only pull the required `expectedAssets` from them up to that maximum limit.
2. Or, allow standard ERC-4626 `deposit` logic to handle the conversion naturally without strict equality restrictions.
