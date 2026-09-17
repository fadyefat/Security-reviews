import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

describe("PoC: Private Swap Cashback Misattribution", function () {
  let deployer: any;
  let realUser: any;
  let ammManager: any;
  let vaultContract: any;
  let router: any;
  let factory: any;
  let wzen: any;
  let rewardsEngine: any;
  let tokenA: any;
  let tokenB: any;

  before(async function () {
    [deployer, realUser, ammManager] = await ethers.getSigners();

    const WZEN = await ethers.getContractFactory("WZEN");
    wzen = await WZEN.deploy();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    tokenA = await MockERC20.deploy("Token A", "TKNA", 18);
    tokenB = await MockERC20.deploy("Token B", "TKNB", 18);

    const Factory = await ethers.getContractFactory("ZendexFactory");
    factory = await upgrades.deployProxy(Factory, [deployer.address, deployer.address], { initializer: "initialize" });

    const RewardsEngine = await ethers.getContractFactory("RewardsEngine");
    rewardsEngine = await upgrades.deployProxy(RewardsEngine, [], { initializer: false });

    const Router = await ethers.getContractFactory("ZendexRouter");
    router = await upgrades.deployProxy(Router, [{
      admin: deployer.address,
      factory: await factory.getAddress(),
      wzen: await wzen.getAddress(),
      rewardsEngine: await rewardsEngine.getAddress()
    }], { initializer: "initialize" });

    await rewardsEngine.initialize({
      admin: deployer.address,
      wzen: await wzen.getAddress(),
      boostManager: deployer.address,
      router: await router.getAddress()
    });

    const ZendexVault = await ethers.getContractFactory("ZendexVault");
    vaultContract = await ZendexVault.deploy({
      zen: await wzen.getAddress(),
      usdt: await tokenA.getAddress(),
      usdc: await tokenB.getAddress(),
      dai: await tokenA.getAddress(),
      admin: deployer.address,
      vaultManager: deployer.address,
      ammManager: ammManager.address,
      orderBookManager: deployer.address
    });

    await factory.createPair(await tokenA.getAddress(), await tokenB.getAddress());
    const pairAddress = await factory.getPair(await tokenA.getAddress(), await tokenB.getAddress());
    await tokenA.mint(pairAddress, ethers.parseEther("100000"));
    await tokenB.mint(pairAddress, ethers.parseEther("100000"));
    const pair = await ethers.getContractAt("ZendexPair", pairAddress);
    await pair.mint(deployer.address);
  });

  it("BUG: Router credits cashback to the actual Vault contract instead of the economic beneficiary", async function () {
    const vaultAddress = await vaultContract.getAddress();
    
    // Note on PoC Scope:
    // This PoC isolates the vulnerable integration point between `ZendexAmmManager` and `ZendexRouter`.
    // It simulates the exact moment `AmmManager` calls the Router on behalf of a private swap.
    
    const amountOut = ethers.parseEther("100");
    const maxAmountIn = ethers.parseEther("150");

    await tokenA.mint(ammManager.address, maxAmountIn);
    await tokenA.connect(ammManager).approve(await router.getAddress(), maxAmountIn);

    // Snapshot exact balances before execution
    const ammBalanceBefore = await tokenA.balanceOf(ammManager.address);
    const userBalanceBefore = await rewardsEngine.getUserCashback(realUser.address, await tokenA.getAddress());
    const vaultBalanceBefore = await rewardsEngine.getUserCashback(vaultAddress, await tokenA.getAddress());

    // Execution: AmmManager calls Router (matching the code in `_executeSwap`).
    // It hardcodes `to: address($.vault)` to collateralize the user's new ZK commitment.
    await router.connect(ammManager).swapTokensForExactTokens({
      amountOut: amountOut,
      amountInMax: maxAmountIn,
      path: [await tokenA.getAddress(), await tokenB.getAddress()],
      to: vaultAddress, // <-- Root cause
      deadline: Math.floor(Date.now() / 1000) + 3600
    });

    // Derive the ACTUAL amount spent by checking state deltas
    const ammBalanceAfter = await tokenA.balanceOf(ammManager.address);
    const actualAmountIn = ammBalanceBefore - ammBalanceAfter;

    // Calculate Expected Cashback Independently using Router's exact configured formula.
    // In `ZendexRouter`, the cashback fee is explicitly 225 out of a 1,000,000 denominator (0.0225%).
    const cashbackFeeNumerator = 225n; 
    const feeDenominator = 1000000n;
    const expectedCashback = (actualAmountIn * cashbackFeeNumerator) / feeDenominator;

    // Query Actual Balances Post-Execution
    const vaultCashback = (await rewardsEngine.getUserCashback(vaultAddress, await tokenA.getAddress())) - vaultBalanceBefore;
    const realUserCashback = (await rewardsEngine.getUserCashback(realUser.address, await tokenA.getAddress())) - userBalanceBefore;

    // Assertions explicitly matching the vulnerability report
    
    // A) Confirm the expected cashback has a real, non-zero economic value
    expect(expectedCashback).to.be.gt(0, "Swap should yield positive cashback");

    // B) Prove the Vault received the EXACT expected amount derived mathematically
    expect(vaultCashback).to.equal(expectedCashback, "Cashback was misattributed to the Vault");

    // C) Prove that the address representing the private swap's economic beneficiary 
    // receives 0 cashback while the Vault receives the entire amount.
    expect(realUserCashback).to.equal(0n, "Economic beneficiary received 0 cashback");

    // D) The Vault exposes no direct reward-claiming or generic-call mechanism.
    // Permanent inaccessibility is established by reviewing the Vault and RewardsEngine
    // execution paths, rather than ABI presence alone. The following asserts that 
    // the Vault lacks standard backdoor/rescue ABI functions.
    expect(vaultContract.interface.hasFunction("claim")).to.be.false;
    expect(vaultContract.interface.hasFunction("execute")).to.be.false;
    expect(vaultContract.interface.hasFunction("rescueTokens")).to.be.false;
  });
});
