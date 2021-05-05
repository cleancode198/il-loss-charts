import { useState, useContext, useEffect, useReducer } from 'react';

import BigNumber from 'bignumber.js';
import { ethers } from 'ethers';
import { Price, Token, TokenAmount } from '@uniswap/sdk-core';
import {
    FeeAmount,
    Pool,
    Position,
    priceToClosestTick,
    tickToPrice,
} from '@uniswap/v3-sdk';
import { resolveLogo } from 'components/token-with-logo';
import { TokenWithBalance } from 'components/token-with-balance';
import './add-liquidity-v3.scss';
import 'rc-slider/assets/index.css';
import { Box } from '@material-ui/core';
import config from 'config';
import erc20Abi from 'constants/abis/erc20.json';
import addLiquidityAbi from 'constants/abis/uniswap_v3_add_liquidity.json';
import { LiquidityContext } from 'containers/liquidity-container';
import { TokenInput } from 'components/token-input';
import { toastSuccess, toastWarn, toastError } from 'util/toasters';
import { ThreeDots } from 'react-loading-icons';
import { compactHash } from 'util/formats';
import { WalletBalances } from 'types/states';
import { useWallet } from 'hooks/use-wallet';
import { usePendingTx, PendingTx } from 'hooks/use-pending-tx';
import { useMarketData } from 'hooks';
import { LiquidityActionButton } from 'components/add-liquidity/liquidity-action-button';
import { EthGasPrices } from '@sommelier/shared-types';
import { PoolOverview } from 'hooks/data-fetchers';
import { debug } from 'util/debug';
import classNames from 'classnames';

type Props = {
    balances: WalletBalances;
    pool: PoolOverview | null;
    gasPrices: EthGasPrices | null;
};

type BoundsState = {
    prices: [number, number];
    ticks: [number, number];
    ticksFromPrice?: [Price, Price];
    position?: Position;
};

export type Sentiment = 'bullish' | 'bearish' | 'neutral';

const ETH_ID = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

export const AddLiquidityV3 = ({
    pool,
    balances,
    gasPrices,
}: Props): JSX.Element | null => {
    const [priceImpact, setPriceImpact] = useState('0');
    const [pendingApproval, setPendingApproval] = useState(false);
    const { setPendingTx } = usePendingTx();
    const token0 = pool?.token0?.id ?? '';
    const token1 = pool?.token1?.id ?? '';
    const token0Symbol = pool?.token0?.symbol ?? '';
    const token1Symbol = pool?.token1?.symbol ?? '';

    // State here is used to compute what tokens are being used to add liquidity with.
    const initialState: Record<string, any> = {
        [token0Symbol]: {
            id: pool?.token0?.id,
            name: pool?.token0?.name,
            symbol: pool?.token0?.symbol,
            amount: '',
            selected: false,
        },
        [token1Symbol]: {
            id: pool?.token1?.id,
            name: pool?.token1?.name,
            symbol: pool?.token1?.symbol,
            amount: '',
            selected: false,
        },
        ETH: {
            id: ETH_ID,
            symbol: 'ETH',
            name: 'Ethereum',
            amount: '',
            selected: true,
        },
        selectedTokens: ['ETH'],
        isWETHSelected:
            pool?.token0?.symbol === 'WETH' || pool?.token1?.symbol === 'WETH',
    };

    const reducer = (
        state: { [x: string]: any },
        action: { type: any; payload: { sym: any; amount?: any } }
    ) => {
        let sym: string;
        let amt: string;
        let selectedSymbols: Array<string>;
        // eslint-disable-next-line no-debugger
        switch (action.type) {
            case 'toggle':
                sym = action.payload.sym;
                // eslint-disable-next-line @typescript-eslint/restrict-plus-operands
                selectedSymbols = state[sym].selected
                    ? state.selectedTokens.filter(
                          (symbol: string) => symbol !== sym
                      )
                    : [...state.selectedTokens, sym];

                return {
                    ...state,
                    selectedTokens: selectedSymbols,
                    [sym]: { ...state[sym], selected: !state[sym].selected },
                };
            case 'update-amount':
                sym = action.payload.sym;
                amt = action.payload.amount;
                return {
                    ...state,
                    [sym]: { ...state[sym], amount: amt },
                };
            default:
                throw new Error();
        }
    };

    const [tokenInputState, dispatch] = useReducer(reducer, initialState);

    // const [token, setToken] = useState('ETH');
    // TODO calculate price impact
    const { selectedGasPrice, slippageTolerance } = useContext(
        LiquidityContext
    );
    let currentGasPrice: number | null = null;
    if (gasPrices && selectedGasPrice) {
        currentGasPrice = gasPrices[selectedGasPrice];
    }

    const [sentiment, setSentiment] = useState<Sentiment>('neutral');
    const [bounds, setBounds] = useState<BoundsState>({
        prices: [0, 0],
        ticks: [0, 0],
    });
    const [pendingBounds, setPendingBounds] = useState<boolean>(true);
    const [expectedAmounts, setExpectedAmounts] = useState<
        [BigNumber, BigNumber]
    >([new BigNumber(0), new BigNumber(0)]);
    const { wallet } = useWallet();

    let provider: ethers.providers.Web3Provider | null = null;
    if (wallet.provider) {
        provider = new ethers.providers.Web3Provider(wallet?.provider);
    }

    (window as any).pool = pool;
    // const token0 = pool?.token0?.id ?? '';
    // const token1 = pool?.token1?.id ?? '';

    const { newPair: marketData, indicators } = useMarketData(
        pool?.token1,
        pool?.token0,
        wallet.network
    );
    debug.marketData = marketData;
    debug.indicators = indicators;

    const getTokensWithAmounts = () => {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-return
        return tokenInputState.selectedTokens.map(
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            (symbol: string) => tokenInputState[symbol]
        );
    };

    debug.selectedTokens = getTokensWithAmounts();
    const SELECTED_INDICATOR_NAME = 'bollingerEMANormalBand';
    const currentPrice = parseFloat(pool?.token0Price || '0');

    useEffect(() => {
        if (!pool || !indicators) {
            return;
        }

        const getPriceImpact = () => {
            if (tokenInputState.selectedTokens.length !== 1) {
                return;
            }

            const selectedToken = tokenInputState.selectedTokens[0];

            const baseTokenCurrency = new Token(
                Number(wallet.network),
                pool.token0.id,
                Number(pool.token0.decimals),
                pool.token0.symbol,
                pool.token0.name
            );
            const quoteTokenCurrency = new Token(
                Number(wallet.network),
                pool.token1.id,
                Number(pool.token1.decimals),
                pool.token1.symbol,
                pool.token1.name
            );

            const uniPool = new Pool(
                baseTokenCurrency,
                quoteTokenCurrency,
                (parseInt(pool.feeTier, 10) as any) as FeeAmount,
                pool.sqrtPrice,
                pool.liquidity,
                parseInt(pool.tick || '0', 10),
                []
            );

            const totalAmount = parseFloat(
                tokenInputState[selectedToken].amount
            );
            if (Number.isNaN(totalAmount) || !totalAmount) {
                return;
            }

            let expectedBaseAmount: BigNumber, expectedQuoteAmount: BigNumber;

            if (selectedToken === 'ETH') {
                if (pool.token0.symbol === 'WETH') {
                    // selected token is base
                    expectedBaseAmount = new BigNumber(totalAmount).div(2);

                    // TODO: reintroduce once we have per-tick liquidity
                    // const baseAmountInBaseUnits = ethers.utils
                    //     .parseUnits(
                    //         expectedBaseAmount.toFixed(),
                    //         baseTokenCurrency.decimals
                    //     )
                    //     .toString()

                    // const [expectedOutput] = await uniPool.getOutputAmount(
                    //     new TokenAmount(baseTokenCurrency, baseAmountInBaseUnits)
                    // );

                    // expectedQuoteAmount = new BigNumber(expectedOutput.toFixed());
                    expectedQuoteAmount = expectedBaseAmount.div(currentPrice);
                } else {
                    // selected token is quote
                    expectedQuoteAmount = new BigNumber(totalAmount).div(2);

                    // TODO: reintroduce once we have per-tick liquidity
                    // const quoteAmountInBaseUnits = ethers.utils
                    //     .parseUnits(
                    //         expectedQuoteAmount.toFixed(),
                    //         baseTokenCurrency.decimals
                    //     )
                    //     .toString();

                    // const [expectedOutput] = await uniPool.getOutputAmount(
                    //     new TokenAmount(baseTokenCurrency, quoteAmountInBaseUnits)
                    // );

                    // expectedBaseAmount = new BigNumber(expectedOutput.toFixed());
                    expectedBaseAmount = expectedQuoteAmount.times(
                        currentPrice
                    );
                }
            } else if (selectedToken === pool.token0.symbol) {
                // selected token is base
                expectedBaseAmount = new BigNumber(totalAmount).div(2);

                // TODO: reintroduce once we have per-tick liquidity
                // const baseAmountInBaseUnits = ethers.utils
                //     .parseUnits(
                //         expectedBaseAmount.toFixed(),
                //         baseTokenCurrency.decimals
                //     )
                //     .toString();

                // const [expectedOutput] = await uniPool.getOutputAmount(
                //     new TokenAmount(baseTokenCurrency, baseAmountInBaseUnits)
                // );

                // expectedQuoteAmount = new BigNumber(expectedOutput.toFixed());
                expectedQuoteAmount = expectedBaseAmount.div(currentPrice);
            } else {
                // selected token is quote
                expectedQuoteAmount = new BigNumber(totalAmount).div(2);

                // TODO: reintroduce once we have per-tick liquidity
                // const quoteAmountInBaseUnits = ethers.utils
                //     .parseUnits(
                //         expectedQuoteAmount.toFixed(),
                //         baseTokenCurrency.decimals
                //     )
                //     .toString()

                // const [expectedOutput] = await uniPool.getOutputAmount(
                //     new TokenAmount(baseTokenCurrency, quoteAmountInBaseUnits)
                // );

                // expectedBaseAmount = new BigNumber(expectedOutput.toFixed());
                expectedBaseAmount = expectedQuoteAmount.times(currentPrice);
            }

            setExpectedAmounts([expectedBaseAmount, expectedQuoteAmount]);

            const expectedQuoteAmountNoSlippage = expectedBaseAmount.times(
                currentPrice
            );
            const priceImpact = new BigNumber(expectedQuoteAmountNoSlippage)
                .minus(expectedQuoteAmount.toFixed(8))
                .div(expectedQuoteAmountNoSlippage)
                .times(100)
                .toFixed();

            setPriceImpact(priceImpact);

            debug.indicators = indicators;

            if (indicators) {
                const indicator = indicators[SELECTED_INDICATOR_NAME];
                const [lowerBound, upperBound] = indicator.bounds[sentiment];

                // Convert to lower tick and upper ticks
                const lowerBoundPrice = new Price(
                    baseTokenCurrency,
                    quoteTokenCurrency,
                    ethers.utils
                        .parseUnits(
                            new BigNumber(lowerBound).toFixed(
                                quoteTokenCurrency.decimals
                            ),
                            quoteTokenCurrency.decimals
                        )
                        .toString(),
                    ethers.utils
                        .parseUnits('1', quoteTokenCurrency.decimals)
                        .toString()
                );
                let lowerBoundTick = priceToClosestTick(lowerBoundPrice);
                lowerBoundTick -= lowerBoundTick % uniPool.tickSpacing;

                const upperBoundPrice = new Price(
                    baseTokenCurrency,
                    quoteTokenCurrency,
                    ethers.utils
                        .parseUnits(
                            new BigNumber(upperBound).toFixed(
                                quoteTokenCurrency.decimals
                            ),
                            quoteTokenCurrency.decimals
                        )
                        .toString(),
                    ethers.utils
                        .parseUnits('1', quoteTokenCurrency.decimals)
                        .toString()
                );
                let upperBoundTick = priceToClosestTick(upperBoundPrice);
                upperBoundTick -= upperBoundTick % uniPool.tickSpacing;

                const sortedTicks = [lowerBoundTick, upperBoundTick].sort(
                    (a, b) => a - b
                ) as [number, number];
                const priceLower = tickToPrice(
                    baseTokenCurrency,
                    quoteTokenCurrency,
                    sortedTicks[0]
                );
                const priceUpper = tickToPrice(
                    baseTokenCurrency,
                    quoteTokenCurrency,
                    sortedTicks[1]
                );
                const baseAmount0 = ethers.utils
                    .parseUnits(
                        expectedBaseAmount.toFixed(
                            Number(pool.token0.decimals)
                        ),
                        pool.token0.decimals
                    )
                    .toString();

                const baseAmount1 = ethers.utils
                    .parseUnits(
                        expectedQuoteAmount.toFixed(
                            Number(pool.token1.decimals)
                        ),
                        pool.token1.decimals
                    )
                    .toString();

                console.log('THIS IS TICKS', sortedTicks);
                const position = Position.fromAmounts({
                    pool: uniPool,
                    tickLower: sortedTicks[0],
                    tickUpper: sortedTicks[1],
                    amount0: baseAmount0,
                    amount1: baseAmount1,
                });

                (window as any).position = position;

                setBounds({
                    prices: [lowerBound, upperBound],
                    ticks: sortedTicks,
                    ticksFromPrice: [priceLower, priceUpper],
                    position,
                });
                setPendingBounds(false);
            }
        };

        void getPriceImpact();
    }, [tokenInputState, sentiment, indicators, pool, wallet.network, currentPrice]);

    if (!pool) return null;

    const doAddLiquidity = async () => {
        if (!pool || !provider || !indicators || !bounds.position) return;
        if (!currentGasPrice) {
            throw new Error('Gas price not selected.');
        }

        const addLiquidityContractAddress =
            config.networks[wallet.network || '1']?.contracts?.ADD_LIQUIDITY_V3;

        if (!addLiquidityContractAddress) {
            throw new Error(
                'Add liquidity contract not available on this network.'
            );
        }

        // Create signer
        const signer = provider.getSigner();
        // Create read-write contract instance
        const addLiquidityContract = new ethers.Contract(
            addLiquidityContractAddress,
            addLiquidityAbi,
            signer
        );

        debug.contract = addLiquidityContract;

        const isEthAdd =
            tokenInputState.selectedTokens.length == 1 &&
            tokenInputState.selectedTokens[0] === 'ETH';

        const fnName = isEthAdd
            ? 'addLiquidityEthForUniV3'
            : 'addLiquidityForUniV3';
        const tokenId = 0;
        const [expectedBaseAmount, expectedQuoteAmount] = expectedAmounts;

        // TODO: Calculate this once we have price impact
        // let expectedQuoteAmountNoSlippage: BigNumber;
        const expectedQuoteAmountNoSlippage = expectedQuoteAmount;

        const slippageRatio = new BigNumber(slippageTolerance as number).div(
            100
        );

        console.log(
            'EXPECTED BASE',
            expectedBaseAmount.toFixed(Number(pool.token0.decimals))
        );
        console.log(
            'EXPECTED QUOTE',
            expectedQuoteAmountNoSlippage.toFixed(Number(pool.token1.decimals))
        );

        const baseAmount0Desired = ethers.utils
            .parseUnits(
                expectedBaseAmount.toFixed(Number(pool.token0.decimals)),
                pool.token0.decimals
            )
            .toString();

        const baseAmount1Desired = ethers.utils
            .parseUnits(
                expectedQuoteAmountNoSlippage.toFixed(
                    Number(pool.token1.decimals)
                ),
                pool.token1.decimals
            )
            .toString();

        const mintAmount0 = bounds.position.mintAmounts.amount0.toString();
        const mintAmount1 = bounds.position.mintAmounts.amount1.toString();

        // TODO: Come back to this. The min amounts don't represent min tokens
        // in the pool, but min deltas. Needs a closer look.
        // const amount0Min = new BigNumber(mintAmount0).times(
        //     new BigNumber(1).minus(slippageRatio)
        // ).times(0.2);
        // const amount1Min = new BigNumber(mintAmount1).times(
        //     new BigNumber(1).minus(slippageRatio)
        // ).times(0.2);

        // const baseAmount0Min = amount0Min.toFixed(0);
        // const baseAmount1Min = amount1Min.toFixed(0);

        const mintParams = [
            token0, // token0
            token1, // token1
            pool.feeTier, // feeTier
            bounds.position.tickLower, // tickLower
            bounds.position.tickUpper, // tickUpper
            mintAmount0, // amount0Desired
            mintAmount1, // amount1Desired
            0,
            0,
            wallet.account, // recipient
            Math.floor(Date.now() / 1000) + 86400000, // deadline
        ];

        console.log('THIS IS MINT PARAMS');
        console.log(mintParams);
        console.log('FN NAME', fnName);

        const baseGasPrice = ethers.utils
            .parseUnits(currentGasPrice.toString(), 9)
            .toString();

        // approve DAI. TODO: Make this approval separate
        for (const tokenSymbol of [pool.token0.symbol, pool.token1.symbol]) {
            // IF WETH, check if ETH is selected - if not, approve WETH
            // IF NOT WETH, approve
            if (tokenSymbol === 'WETH') {
                const selectedTokens = tokenInputState.selectedTokens;
                if (
                    selectedTokens.length === 1 &&
                    selectedTokens[0] === 'ETH'
                ) {
                    continue;
                }
            }

            const erc20Contract = new ethers.Contract(
                tokenInputState[tokenSymbol].id,
                erc20Abi,
                signer
            );

            const amountDesired =
                tokenSymbol === pool.token0.symbol
                    ? baseAmount0Desired
                    : baseAmount1Desired;

            const baseApproveAmount = new BigNumber(amountDesired)
                .times(100)
                .toFixed();

            // Call the contract and sign
            let approvalEstimate: ethers.BigNumber;

            try {
                approvalEstimate = await erc20Contract.estimateGas.approve(
                    addLiquidityContractAddress,
                    baseApproveAmount,
                    { gasPrice: baseGasPrice }
                );

                // Add a 30% buffer over the ethers.js gas estimate. We don't want transactions to fail
                approvalEstimate = approvalEstimate.add(
                    approvalEstimate.div(3)
                );
            } catch (err) {
                // We could not estimate gas, for whaever reason, so we will use a high default to be safe.
                console.error(
                    `Could not estimate gas fees: ${err.message as string}`
                );

                toastError(
                    'Could not estimate gas for this transaction. Check your parameters or try a different pool.'
                );
                return;
            }

            // Approve the add liquidity contract to spend entry tokens
            setPendingApproval(true);
            let approveHash: string | undefined;
            try {
                const {
                    hash,
                } = await erc20Contract.approve(
                    addLiquidityContractAddress,
                    baseApproveAmount,
                    { gasPrice: baseGasPrice, gasLimit: approvalEstimate }
                );
                approveHash = hash;
            } catch (e) {
                setPendingApproval(false);
                return;
            }

            // setApprovalState('pending');
            if (approveHash) {
                toastWarn(`Approving tx ${compactHash(approveHash)}`);
                setPendingTx &&
                    setPendingTx(
                        (state: PendingTx): PendingTx =>
                            ({
                                approval: [...state.approval, approveHash],
                                confirm: [...state.confirm],
                            } as PendingTx)
                    );
                await provider.waitForTransaction(approveHash);
                setPendingApproval(false);
                setPendingTx &&
                    setPendingTx(
                        (state: PendingTx): PendingTx =>
                            ({
                                approval: [
                                    ...state.approval.filter(
                                        (h) => h != approveHash
                                    ),
                                ],
                                confirm: [...state.confirm],
                            } as PendingTx)
                    );
            }
        }

        let baseMsgValue = ethers.utils.parseUnits('0.005', 18);
        if (tokenInputState.selectedTokens.includes('ETH')) {
            const ethAmount = ethers.utils.parseEther(
                tokenInputState['ETH'].amount
            );
            baseMsgValue = baseMsgValue.add(ethAmount);
        }

        const value = baseMsgValue.toString();

        // Call the contract and sign
        let gasEstimate: ethers.BigNumber;

        try {
            gasEstimate = await addLiquidityContract.estimateGas[fnName](
                tokenId,
                mintParams,
                {
                    gasPrice: baseGasPrice,
                    value, // flat fee sent to contract - 0.0005 ETH - with ETH added if used as entry
                }
            );

            // Add a 30% buffer over the ethers.js gas estimate. We don't want transactions to fail
            gasEstimate = gasEstimate.add(gasEstimate.div(3));
        } catch (err) {
            // We could not estimate gas, for whaever reason, so we will use a high default to be safe.
            console.error(`Could not estimate gas: ${err.message as string}`);

            toastError(
                'Could not estimate gas for this transaction. Check your parameters or try a different pool.'
            );
            return;
        }

        const { hash } = await addLiquidityContract[fnName](
            tokenId,
            mintParams,
            {
                gasPrice: baseGasPrice,
                value, // flat fee sent to contract - 0.0005 ETH - with ETH added if used as entry
            }
        );
        toastWarn(`Confirming tx ${compactHash(hash)}`);
        setPendingTx &&
            setPendingTx(
                (state: PendingTx): PendingTx =>
                    ({
                        approval: [...state.approval],
                        confirm: [...state.confirm, hash],
                    } as PendingTx)
            );
        if (provider) {
            const txStatus: ethers.providers.TransactionReceipt = await provider.waitForTransaction(
                hash
            );

            const { status } = txStatus;

            if (status === 1) {
                toastSuccess(`Confirmed tx ${compactHash(hash)}`);
                setPendingTx &&
                    setPendingTx(
                        (state: PendingTx): PendingTx =>
                            ({
                                approval: [...state.approval],
                                confirm: [
                                    ...state.approval.filter(
                                        (hash) => hash !== hash
                                    ),
                                ],
                            } as PendingTx)
                    );
            } else {
                toastError(`Rejected tx ${compactHash(hash)}`);
                setPendingTx &&
                    setPendingTx(
                        (state: PendingTx): PendingTx =>
                            ({
                                approval: [...state.approval],
                                confirm: [
                                    ...state.approval.filter(
                                        (hash) => hash !== hash
                                    ),
                                ],
                            } as PendingTx)
                    );
            }
        }
    };

    // if (!pool || !pool?.token0 || !pool?.token1) return null;
    debug.marketData = marketData;

    const selectedSymbolCount = tokenInputState.selectedTokens.length;
    const isToken0Active = tokenInputState?.[token0Symbol]?.selected;
    const isToken1Active = tokenInputState?.[token1Symbol]?.selected;
    const isTokenETHActive = tokenInputState?.['ETH']?.selected;
    const isToken0Disabled = !isToken0Active && selectedSymbolCount === 2;
    const isToken1Disabled = !isToken1Active && selectedSymbolCount === 2;
    const isTokenETHDisabled =
        !isTokenETHActive &&
        (selectedSymbolCount === 2 || tokenInputState['WETH']?.selected);
    const selectedSymbol0 = tokenInputState.selectedTokens[0];
    const selectedSymbol1 = tokenInputState.selectedTokens[1];
    const disableWETH = tokenInputState['ETH'].selected;

    return (
        <>
            <div className='add-v3-container'>
                <Box
                    display='flex'
                    justifyContent='space-between'
                    alignItems='center'
                >
                    <div>Select 1 or 2 token(s)</div>
                    <Box display='flex' className='token-select'>
                        <button
                            className={classNames('token-with-logo', {
                                active: isToken0Active,
                                disabled:
                                    isToken0Disabled ||
                                    (token0Symbol === 'WETH' && disableWETH),
                            })}
                            disabled={
                                isToken0Disabled ||
                                (token0Symbol === 'WETH' && disableWETH)
                            }
                            onClick={() => {
                                dispatch({
                                    type: 'toggle',
                                    payload: { sym: token0Symbol },
                                });
                            }}
                        >
                            {resolveLogo(pool?.token0?.id)}&nbsp;
                            {pool?.token0?.symbol}
                        </button>
                        <button
                            className={classNames('token-with-logo', {
                                active: isToken1Active,
                                disabled:
                                    isToken1Disabled ||
                                    (token1Symbol === 'WETH' && disableWETH),
                            })}
                            disabled={
                                isToken1Disabled ||
                                (token1Symbol === 'WETH' && disableWETH)
                            }
                            onClick={() => {
                                if (
                                    !isToken1Active &&
                                    selectedSymbolCount === 2
                                )
                                    return;
                                dispatch({
                                    type: 'toggle',
                                    payload: { sym: token1Symbol },
                                });
                            }}
                        >
                            {resolveLogo(pool?.token1?.id)}&nbsp;
                            {pool?.token1?.symbol}
                        </button>
                        <button
                            className={classNames('token-with-logo', {
                                active: isTokenETHActive,
                                disabled: isTokenETHDisabled,
                            })}
                            disabled={isTokenETHDisabled}
                            onClick={() => {
                                if (
                                    !isTokenETHActive &&
                                    selectedSymbolCount === 2
                                )
                                    return;
                                dispatch({
                                    type: 'toggle',
                                    payload: { sym: 'ETH' },
                                });
                            }}
                        >
                            {resolveLogo(ETH_ID)}&nbsp;
                            {'ETH'}
                        </button>
                    </Box>
                </Box>
                <br />
                <Box display='flex' justifyContent='space-between'>
                    <Box width='48%'>
                        {selectedSymbol0 && (
                            <TokenWithBalance
                                id={tokenInputState[selectedSymbol0].id}
                                name={selectedSymbol0}
                                balance={balances?.[selectedSymbol0]?.balance}
                                decimals={balances?.[selectedSymbol0]?.decimals}
                            />
                        )}
                        <br />
                        {selectedSymbol1 && (
                            <TokenWithBalance
                                id={tokenInputState[selectedSymbol1].id}
                                name={selectedSymbol1}
                                balance={balances?.[selectedSymbol1]?.balance}
                                decimals={balances?.[selectedSymbol1]?.decimals}
                            />
                        )}
                    </Box>
                    <Box width='48%'>
                        {selectedSymbol0 && (
                            <TokenInput
                                token={selectedSymbol0}
                                amount={tokenInputState[selectedSymbol0].amount}
                                updateAmount={(amt: string) => {
                                    dispatch({
                                        type: 'update-amount',
                                        payload: {
                                            sym: selectedSymbol0,
                                            amount: amt,
                                        },
                                    });
                                }}
                                handleTokenRatio={() => {
                                    return '';
                                }}
                                balances={balances}
                                twoSide={false}
                            />
                        )}
                        <br />
                        {selectedSymbol1 && (
                            <TokenInput
                                token={selectedSymbol1}
                                amount={tokenInputState[selectedSymbol1].amount}
                                updateAmount={(amt: string) => {
                                    dispatch({
                                        type: 'update-amount',
                                        payload: {
                                            sym: selectedSymbol1,
                                            amount: amt,
                                        },
                                    });
                                }}
                                handleTokenRatio={() => {
                                    return '';
                                }}
                                balances={balances}
                                twoSide={true}
                            />
                        )}
                    </Box>
                </Box>
                <br />
                <Box
                    display='flex'
                    justifyContent='space-between'
                    className='sentiment'
                >
                    <div
                        className={classNames({
                            'sentiment-button': true,
                            active: sentiment === 'bearish',
                        })}
                        onClick={() => setSentiment('bearish')}
                    >
                        📉 Bearish
                    </div>
                    <div
                        className={classNames({
                            'sentiment-button': true,
                            active: sentiment === 'neutral',
                        })}
                        onClick={() => setSentiment('neutral')}
                    >
                        Neutral
                    </div>
                    <div
                        className={classNames({
                            'sentiment-button': true,
                            active: sentiment === 'bullish',
                        })}
                        onClick={() => setSentiment('bullish')}
                    >
                        📈 Bullish
                    </div>
                </Box>
                <br />
                <div className='preview'>
                    <Box display='flex' justifyContent='space-between'>
                        <div>Current Price</div>
                        <div>
                            <span className='face-deep'>
                                {currentPrice} {pool.token0.symbol} per{' '}
                                {pool.token1.symbol}
                            </span>
                        </div>
                    </Box>
                    <Box display='flex' justifyContent='space-between'>
                        <div>Liquidity Range</div>
                        <div>
                            <span className='face-positive'>
                                {pendingBounds ? (
                                    <ThreeDots width='24px' height='10px' />
                                ) : (
                                    `${bounds.prices[0]} to ${bounds.prices[1]}`
                                )}
                            </span>
                        </div>
                    </Box>
                    {/* TODO Re-introduce once we know per-tick liqudity
                        {selectedSymbolCount == 1 && (
                        <Box display='flex' justifyContent='space-between'>
                            <div>Expected Price Impact</div>
                            <div>
                                <span className='price-impact'>
                                    {priceImpact}%
                                </span>
                            </div>
                        </Box>
                    )} */}
                </div>
                <br />
                <div>
                    <LiquidityActionButton
                        tokenInputState={tokenInputState}
                        pendingApproval={pendingApproval}
                        onClick={() => doAddLiquidity()}
                        balances={balances}
                        pendingBounds={pendingBounds}
                    />
                </div>
            </div>
        </>
    );
};
