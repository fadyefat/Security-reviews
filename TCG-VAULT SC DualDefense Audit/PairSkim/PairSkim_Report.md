### [Critical] Pre-existing Unsynced TCGV Pair Surplus Can Be Extracted as USDC via `sellTCGVForUSDC`

**Description**
The `TCGVaultBuyRouter` contract acts as a peripheral for swapping `TCGV` for `USDC` using the `sellTCGVForUSDC` function. This function executes the swap on behalf of the `msg.sender` (the user), but a critical flaw exists in how it calculates the input amount for the underlying swap. 

Inside the internal `_swapSupportingFeeOnTransferTokens` function, the router calculates the input based on the entire excess balance of the pair:
`amountInput = IERC20(tcgv).balanceOf(address(pair)) - reserveIn;`

While this mimics the logic of the `PancakeRouter`, it creates a fatal vulnerability because the router interprets the entire balance delta between the Pair's current token balance and its stored reserve as the current swap's input, without distinguishing pre-existing surplus from tokens transferred by the current caller. 

During the audit, we proved that a natural "Naked Transfer" production flow creates a massive `TCGV` surplus in the pair. Specifically, when any regular user transfers `TCGV` directly to the `PancakePair` (e.g., by mistake or attempting single-sided liquidity), the `TCGVaultToken` intercepts the transfer via its `_update` hook and treats it as a sell (`to == pair`). The token contract deducts the 5% sell tax and sends the remaining 95% to the Pair. However, because this is a direct ERC-20 transfer and not routed through a DEX router, `pair.swap()` or `pair.sync()` is never called. This leaves the 95% remaining as an unsynced surplus in the Pair's balance without updating the reserves. 

If there are any such unsynced or excess `TCGV` tokens in the Pair, an attacker can exploit `sellTCGVForUSDC`. By calling it with a minimal amount (e.g., `1 wei`), the router transfers `1 wei` from the attacker to the Pair. It then uses the `balanceOf(pair) - reserve` formula to calculate the input, incorrectly attributing the *entire* unsynced surplus (plus the `1 wei`) as the user's input. The pair is then forced to swap this massive amount into `USDC`, and the router sends the resulting `USDC` directly to the attacker.

**Impact**
**High.** An attacker can extract the USDC value corresponding to an unsynced TCGV surplus from the Pair while contributing only a negligible amount of TCGV. The amount extractable scales with the size of the unsynced surplus and the Pair's available USDC liquidity.

**Severity Justification:**
Evaluated as **High** based on standard auditing severity matrices:
- **Impact (High):** Direct loss of Pair liquidity originating from users' direct transfers, as the resulting unsynced surplus can be deterministically extracted by an attacker.
- **Likelihood (High):** The exploit requires no privileges and can be executed by anyone. The surplus naturally builds up via standard ERC-20 transfers to the pair.

**Proof of Concept**
To reproduce the exploit showing an attacker stealing $6,394 of USDC for exactly `1 wei` of TCGV, run the Hardhat test below:

```bash
npx hardhat test audit_reports/PairSkim/PairSkim.test.ts
```

**PoC Output:**
```text
[+] Pair reserves BEFORE direct transfer:
    Reserve0=10000000000
    Reserve1=47500000000000000000000
[+] Pair ACTUAL TCGV BEFORE: 47500000000000000000000
[+] Pair ACTUAL USDC BEFORE: 10000000000

[+] Normal user TCGV spent: 100000000000000000000000
[+] Pair reserves AFTER direct transfer:
    Reserve0=10000000000
    Reserve1=47500000000000000000000
[+] Pair ACTUAL TCGV AFTER: 142500000000000000000000
[+] Pair ACTUAL USDC AFTER: 10000000000
[+] TCGV actually received by Pair: 95000000000000000000000
[!] Unsynced TCGV surplus: 95000000000000000000000

[+] Attacker USDC BEFORE: 1000000000
[+] Attacker TCGV BEFORE: 10000000000000000000

[+] Attacker USDC AFTER: 7394657763
[+] Attacker TCGV AFTER: 9999999999999999999

[+] Pair reserves AFTER ATTACK:
    Reserve0=3338898164
    Reserve1=142500000000000000000001
[+] Pair ACTUAL TCGV AFTER ATTACK: 142500000000000000000001
[+] Pair ACTUAL USDC AFTER ATTACK: 3338898164

[!] Attacker USDC gained: 6394657763
[!] Pair USDC loss: 6661101836

[!!!] EXPLOIT SUCCESSFUL
[!!!] Attacker spent: 1 wei TCGV
[!!!] Attacker gained: 6394657763 USDC units
[!!!] Unsynced surplus exploited: 95000000000000000000000 TCGV
```

The attacker receives 6,394.657763 USDC while the Pair loses 6,661.101836 USDC, with the difference attributable to the protocol's configured fees/recipient flows. The attacker contributes only 1 wei of TCGV.

> **Note:** The `mintPresale` call in the test is only used to provision the test user with tokens. It is not required for the attacker and does not represent a privileged action performed by the attacker.

**Mitigation**
The protocol must ensure that pre-existing Pair surpluses cannot be interpreted as the current user's swap input. Before executing a user-initiated sell, the router should ensure that the Pair's token balance is synchronized with its reserves, or otherwise isolate/reconcile any pre-existing surplus before performing the swap.

Alternatively, the protocol can prevent direct TCGV transfers to the Pair from creating an exploitable unsynced balance, or provide a controlled mechanism for recovering/synchronizing such balances.

Liquidity additions should be performed through the intended liquidity-management flow rather than arbitrary direct transfers to the Pair.
