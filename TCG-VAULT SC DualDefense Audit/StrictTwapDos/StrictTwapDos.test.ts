import { describe, it } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { parseEther, parseUnits, getContractAddress, zeroAddress } from "viem";

const { viem, networkHelpers } = await hre.network.connect();

async function deployFixture() {
    const wallets = await viem.getWalletClients();
    const owner = wallets[0]!;
    const userA = wallets[1]!;
    const vault = wallets[2]!;
    const marketing = wallets[3]!;
    const community = wallets[4]!;
    const team = wallets[5]!;
    const casp = wallets[6]!;

    const publicClient = await viem.getPublicClient();

    // 1. Deploy Mocks
    const usdcContract = await viem.deployContract("contracts/test/MockUSDC.sol:MockUSDC", [], { client: { wallet: owner } });
    const usdcAddress = usdcContract.address;
    const usdc = await viem.getContractAt("MockUSDC", usdcAddress);

    const factoryContract = await viem.deployContract("MockUniswapV2Factory", [], { client: { wallet: owner } });
    const factoryAddress = factoryContract.address;
    const factory = await viem.getContractAt("MockUniswapV2Factory", factoryAddress);

    const routerContract = await viem.deployContract("MockUniswapV2Router", [factoryAddress, usdcAddress], { client: { wallet: owner } });
    const routerAddress = routerContract.address;

    // 2. Precompute addresses
    const n0 = BigInt(await publicClient.getTransactionCount({ address: owner.account.address, blockTag: "pending" }));
    const nexusAddr = getContractAddress({ from: owner.account.address, nonce: n0 });
    // TCGVaultToken is nonce n0
    // BuyRouter is nonce n0 + 1
    const stakingVaultAddr = getContractAddress({ from: owner.account.address, nonce: n0 + 2n });
    
    // 3. Deploy TCGV
    const tcgvContract = await viem.deployContract("TCGVaultToken", [
        stakingVaultAddr, // stakingVault_
        routerAddress,
        vault.account.address,
        marketing.account.address,
        community.account.address,
        nexusAddr,
        owner.account.address, // initialLaunch_
    ], { client: { wallet: owner } });
    const tcgvAddress = tcgvContract.address;
    const tcgv = await viem.getContractAt("TCGVaultToken", tcgvAddress);

    // 4. Create pair & set it in TCGV
    await factory.write.createPair([tcgvAddress, usdcAddress], { account: owner.account });
    const pairAddress = await factory.read.getPair([tcgvAddress, usdcAddress]);
    const pair = await viem.getContractAt("MockUniswapV2Pair", pairAddress);
    await tcgv.write.setPair([pairAddress, true], { account: owner.account });

    // 5. Deploy BuyRouter
    const buyRouter = await viem.deployContract("TCGVaultBuyRouter", [
        routerAddress,
        usdcAddress,
        tcgvAddress,
        vault.account.address,
        marketing.account.address,
        community.account.address,
    ], { client: { wallet: owner } });

    // 6. Deploy Staking Vault & Basic NFT
    const stakingVaultContract = await viem.deployContract("TCGVaultStakingVault", [tcgvAddress], { client: { wallet: owner } });
    const stakingVault = await viem.getContractAt("TCGVaultStakingVault", stakingVaultContract.address);

    const basicNFT = await viem.deployContract("TCGVaultBasicNFT", [stakingVaultContract.address], { client: { wallet: owner } });

    await stakingVault.write.setBasicNFTContract([basicNFT.address], { account: owner.account });

    // 7. Seed LP pool so TWAP can initialize
    await tcgv.write.mintPresale([owner.account.address, parseEther("100000")], { account: owner.account });
    const usdcLiq = parseUnits("10000", 6); // 10k USDC
    const tcgvLiq = parseEther("50000");    // 50k TCGV (implies 1 TCGV = 0.20 USDC)
    await usdc.write.mint([owner.account.address, usdcLiq], { account: owner.account });
    await usdc.write.transfer([pairAddress, usdcLiq], { account: owner.account });
    await tcgv.write.transfer([pairAddress, tcgvLiq], { account: owner.account });
    await pair.write.mint([owner.account.address], { account: owner.account });

    // Initialize TWAP in StakingVault by setting the router
    await stakingVault.write.setBasicNFTPricingRouter([buyRouter.address], { account: owner.account });

    // 8. Mint USDC and TCGV to UserA so they can stake
    await usdc.write.mint([userA.account.address, parseUnits("1000", 6)], { account: owner.account });
    await tcgv.write.mintPresale([userA.account.address, parseEther("5000")], { account: owner.account });
    await tcgv.write.approve([stakingVaultContract.address, parseEther("5000")], { account: userA.account });

    return { owner, userA, usdc, tcgv, pair, stakingVault, publicClient };
}

describe("TCGVaultStakingVault - Strict TWAP Equality DoS", function () {
    it("Should revert user's deposit transaction if mined a few seconds later due to TWAP movement", async function () {
        const fix = await networkHelpers.loadFixture(deployFixture);
        
        // 1. Fast forward time by 2 days so the TWAP window goes beyond the MIN_WINDOW (1 day)
        // This makes the TWAP dynamically active rather than returning the fallback.
        await networkHelpers.time.increase(86400 * 2);

        // 2. We change the spot price slightly so that the TWAP begins to shift every second
        // We simulate a small buy that changes reserves.
        const pairBalanceTCGV = await fix.tcgv.read.balanceOf([fix.pair.address]);
        const pairBalanceUSDC = await fix.usdc.read.balanceOf([fix.pair.address]);
        
        // Small swap by owner
        const usdcIn = parseUnits("10", 6);
        await fix.usdc.write.mint([fix.owner.account.address, usdcIn]);
        await fix.usdc.write.transfer([fix.pair.address, usdcIn]);
        // Call sync to update reserves and accumulators at current timestamp
        await fix.pair.write.sync(); 

        // Advance 1 hour to let the new spot price affect the TWAP meaningfully
        await networkHelpers.time.increase(3600);

        // ==========================================
        // AT T_0: User's Frontend Calculates Assets
        // ==========================================
        // The frontend calls maxDeposit to see how much TCGV exactly is required for the Basic NFT
        const expectedAssetsT0 = await fix.stakingVault.read.maxDeposit([fix.userA.account.address]);
        
        // The frontend builds the transaction: deposit(expectedAssetsT0, userA)
        // User A signs the transaction in MetaMask and broadcasts it.

        // ==========================================
        // AT T_1: Transaction is Mined 15 seconds later
        // ==========================================
        // The block is mined 15 seconds after T0. 
        await networkHelpers.time.increase(15);
        
        // At T_1, the dynamic TWAP accumulator has shifted by 15 seconds.
        // Because of Q112 precision, avgPerSec will have changed, causing the required assets to drift.
        const expectedAssetsT1 = await fix.stakingVault.read.maxDeposit([fix.userA.account.address]);
        
        // Prove that the required assets have drifted
        assert.notEqual(expectedAssetsT0, expectedAssetsT1, "Required assets should have drifted due to time passing");

        // The transaction executes: deposit(expectedAssetsT0, userA)
        await assert.rejects(
            fix.stakingVault.write.deposit([expectedAssetsT0, fix.userA.account.address], { account: fix.userA.account }),
            (err: any) => {
                // Should revert with InvalidVaultAmount because assets != expectedAssetsT1
                return err.message.includes("InvalidVaultAmount");
            },
            "Transaction should revert with InvalidVaultAmount due to strict equality check"
        );

        console.log(`\n\t[+] DoS Confirmed!`);
        console.log(`\t[+] Expected Assets at T_0 (Signed by user): ${expectedAssetsT0}`);
        console.log(`\t[+] Expected Assets at T_1 (Mined block):    ${expectedAssetsT1}`);
    });
});
