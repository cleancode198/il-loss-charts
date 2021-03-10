import { useState, useEffect, useMemo } from 'react';
import {
    Alert,
    Container,
    Row,
    Col,
    Card,
    ButtonGroup,
    Button,
    Form,
    FormControl,
    Modal,
} from 'react-bootstrap';

import { Combobox } from 'react-widgets';
import { ethers } from 'ethers';
import BigNumber from 'bignumber.js';

import mixpanel from 'util/mixpanel';

import erc20Abi from 'constants/abis/erc20.json';
import exchangeRemoveAbi from 'constants/abis/volumefi_remove_liquidity_uniswap.json';

const EXCHANGE_REMOVE_ABI_ADDRESS = '0x418915329226AE7fCcB20A2354BbbF0F6c22Bd92';

import {
    EthGasPrices,
    LPPositionData,
    UniswapPair,
    Token
} from '@sommelier/shared-types';
import { Wallet, WalletBalances, ManageLiquidityActionState } from 'types/states';

import TokenWithLogo, { resolveLogo } from 'components/token-with-logo';
import { RemoveLiquidityActionButton } from 'components/liquidity-action-button';

function RemoveLiquidity({
    wallet,
    provider,
    pairData,
    positionData,
    gasPrices,
    balances,
    onDone
}: {
    wallet: Wallet;
    provider: ethers.providers.Web3Provider | null;
    pairData: UniswapPair | null;
    positionData: LPPositionData<string> | null;
    gasPrices: EthGasPrices | null;
    balances: WalletBalances
    onDone: () => void | null
}): JSX.Element | null {
    const [exitToken, setExitToken] = useState<string>('ETH');
    const [exitAmount, setExitAmount] = useState<number>(0);
    const [currentGasPrice, setCurrentGasPrice] = useState<number | undefined>(
        gasPrices?.standard
    );
    const [approvalState, setApprovalState] = useState<'needed' | 'pending' | 'done'>('needed');
    const [txSubmitted, setTxSubmitted] = useState(false);

    const resetForm = () => {
        setExitToken('ETH');
        setExitAmount(0);
    };

    const expectedExitToken = useMemo(() => {
        if (!positionData || !pairData) return '0';

        const pctShare = new BigNumber(exitAmount).div(pairData.totalSupply);
        // Calculate amount of base token one will get, plus swap data
        
        const symbol0 = pairData.token0.symbol;
        const symbol1 = pairData.token1.symbol;

        const currentInvariant = new BigNumber(pairData.reserve0).times(pairData.reserve1);

        if (exitToken === symbol0 || (symbol0 === 'WETH' && exitToken === 'ETH')) {
            // We want to sell symbol1 to get symbol0
            let expectedToken0 = pctShare.times(pairData.reserve0);
            const expectedToken1 = pctShare.times(pairData.reserve1);

            // Deduct fee from amount we can swap
            const purchasingPower = new BigNumber(0.997).times(expectedToken1);
            const updatedReserve1 = new BigNumber(pairData.reserve1).plus(purchasingPower);
            const updatedReserve0 = currentInvariant.div(updatedReserve1);
            // const newPriceRatio = updatedReserve0.div(updatedReserve1);

            const expectedAdditionalToken0 = updatedReserve0.minus(pairData.reserve0).times(-1).toFixed(4);
            const invariantAfterSwap = updatedReserve0.times(updatedReserve1);

            if (invariantAfterSwap.toFixed(4) !== currentInvariant.toFixed(4)) {
                // throw new Error(`Swap expectations do not meet invariant - old ${currentInvariant.toFixed(4)} - new ${invariantAfterSwap.toFixed(4)}`);
                console.warn(`Swap expectations do not meet invariant - old ${currentInvariant.toFixed()} - new ${invariantAfterSwap.toFixed()}`);
            }

            expectedToken0 = expectedToken0.plus(expectedAdditionalToken0);
            return expectedToken0.toFixed(4);
        } else if (exitToken === symbol1 || (symbol1 === 'WETH' && exitToken === 'ETH')) {
            // We want to sell symbol0 to get symbol1
            const expectedToken0 = pctShare.times(pairData.reserve0);
            let expectedToken1 = pctShare.times(pairData.reserve1);

            // Deduct fee from amount we can swap
            const purchasingPower = new BigNumber(0.997).times(expectedToken0);
            const updatedReserve0 = new BigNumber(pairData.reserve0).plus(purchasingPower);
            const updatedReserve1 = currentInvariant.div(updatedReserve0);
            // const newPriceRatio = updatedReserve0.div(updatedReserve1);

            const expectedAdditionalToken1 = updatedReserve1.minus(pairData.reserve1).times(-1).toFixed(4);
            const invariantAfterSwap = updatedReserve0.times(updatedReserve1);

            if (invariantAfterSwap.toFixed(4) !== currentInvariant.toFixed(4)) {
                // throw new Error(`Swap expectations do not meet invariant - old ${currentInvariant.toFixed(4)} - new ${invariantAfterSwap.toFixed(4)}`);
                console.warn(`Swap expectations do not meet invariant - old ${currentInvariant.toFixed()} - new ${invariantAfterSwap.toFixed()}`);
            }

            expectedToken1 = expectedToken1.plus(expectedAdditionalToken1);
            return expectedToken1.toFixed(4);
        } else if (exitToken === 'ETH') {
            // We need to sell both symbol0 and symbol1 - we need to estimate this one
            // TODO: Figure out better estimation once we figure out ETH pairs
            const owedEth = pctShare.times(pairData.trackedReserveETH);
            return owedEth.toFixed(4);
        } else {
            console.warn(`Exit token ${exitToken} does not belong to pair - could not calculate price impact`);
            return '0';
        }
        // If we are selling X LP tokens,
        // we need to figure out the LP share
        // then figure out the amount of tokens that belong to that share 
    }, [exitToken, exitAmount, pairData, positionData]);

    let currentLpTokens: string | null = null;

    useEffect(() => {
        // No need to check allowances for ETH
        const allowance = balances?.currentPair?.allowance;

        if (!allowance) return;

        const exitAmountNum = new BigNumber(exitAmount);
        const allowanceStr = ethers.utils.formatUnits(
            allowance || 0,
            parseInt(balances.currentPair?.decimals || '0', 10)
        );
        const allowanceNum = new BigNumber(allowanceStr);

        // If allowance is less than entry amount, make it needed
        if (exitAmountNum.gt(allowanceNum)) {
            setApprovalState('needed');
        } else {
            // else make it done
            setApprovalState('done')
        }
    }, [exitAmount, balances]);

    useEffect(() => {
        setExitAmount(0);
    }, []);

    const doApprove = async () => {
        if (!pairData || !provider) return;

        if (!currentGasPrice) {
            throw new Error('Gas price not selected.');
        }

        // // Create signer
        const signer = provider.getSigner();
        // // Create read-write contract instance

        const pairContract = new ethers.Contract(
            pairData.id,
            erc20Abi,
            signer
        );

        const decimals = parseInt(balances.currentPair?.decimals || '0', 10);
        if (decimals === 0) {
            throw new Error(
                `Do not have decimal units for ${decimals} - unsafe, cannot proceed`
            );
        }

        const baseAmount = ethers.utils
            .parseUnits((exitAmount * 100).toString(), decimals)
            .toString();
        const baseGasPrice = ethers.utils
            .parseUnits(currentGasPrice.toString(), 9)
            .toString();

        // // Approve the add liquidity contract to spend entry tokens
        const txResponse = await pairContract.approve(EXCHANGE_REMOVE_ABI_ADDRESS, baseAmount, {
            gasPrice: baseGasPrice,
            gasLimit: '200000', // setting a high gas limit because it is hard to predict gas we will use
        });

        setApprovalState('pending');
        await provider.waitForTransaction(txResponse.hash);
        setApprovalState('done');
    }

    const doRemoveLiquidity = async () => {
        if (!pairData || !provider || !currentLpTokens) return;

        if (!currentGasPrice) {
            throw new Error('Gas price not selected.');
        }

        // Create signer
        const signer = provider.getSigner();
        // Create read-write contract instance
        const removeLiquidityContract = new ethers.Contract(
            EXCHANGE_REMOVE_ABI_ADDRESS,
            exchangeRemoveAbi,
            signer
        );

        // Call the contract and sign
        let exitAddress = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

        if (exitToken === pairData.token0.symbol) {
            exitAddress = (pairData.token0 as Token).id;
        } else if (exitToken === pairData.token1.symbol) {
            exitAddress = (pairData.token1 as Token).id;
        }

        const baseGasPrice = ethers.utils
            .parseUnits(currentGasPrice.toString(), 9)
            .toString();

        const baseMsgValue = ethers.utils.parseUnits('0.01', 18).toString();
        const baseLpTokens = ethers.utils
            .parseUnits(exitAmount.toString(), 18)
            .toString();

        await removeLiquidityContract[
            'divestEthPairToToken(address,address,uint256)'
        ](pairData.id, exitAddress, baseLpTokens, {
            gasPrice: baseGasPrice,
            gasLimit: '500000', // setting a high gas limit because it is hard to predict gas we will use
            value: baseMsgValue, // flat fee sent to contract - 0.0005 ETH
        });

        setTxSubmitted(true);

        // Close the modal after one second
        setTimeout(() => {
            setTxSubmitted(false);
            resetForm();
            onDone?.();
        }, 1000);
    }

    if (positionData && pairData) {
        const pairPosition = positionData.positions[pairData.id];

        if (!pairPosition) {
            currentLpTokens = new BigNumber(0).toFixed(8);
        } else {
            const lastPosition = pairPosition[pairPosition.length - 1];
            currentLpTokens = new BigNumber(
                lastPosition.liquidityTokenBalance
            ).toFixed(8);
        }
    }

    const removeLiquidityActionState: ManageLiquidityActionState = useMemo(() => {
        if (gasPrices == null) {
            return 'awaitingGasPrices';
        } else if (txSubmitted) {
            return 'submitted';
        } else if (!exitAmount || new BigNumber(exitAmount).lte(0)) {
            return 'amountNotEntered';
        } else if (new BigNumber(exitAmount).gt(currentLpTokens || 0)) {
            return 'insufficientFunds';
        } else if (currentGasPrice == null) {
            return 'gasPriceNotSelected';
        } else if (approvalState === 'needed') {
            return 'needsApproval';
        } else if (approvalState === 'pending') {
            return 'waitingApproval';
        } else if (new BigNumber(exitAmount).lte(currentLpTokens || 0) &&
            new BigNumber(exitAmount).gt(0)) {
            return 'needsSubmit';
        } else {
            return 'unknown';
        }
    }, [
        gasPrices,
        currentGasPrice,
        currentLpTokens,
        exitAmount,
        txSubmitted,
        approvalState
    ]);

    if (!wallet || !provider || !pairData) {
        return (
            <p className='centered'>Connect your wallet to continue.</p>
        );
    }

    const renderPairText = (pair: string | { id: string; symbol: string }): string => {
        // If pair is string, it's typed in so return
        if (typeof pair === 'string') return pair;

        return pair.symbol;
    };

    const handleChange = (value: string | { symbol: string }): void => {
        // If pair is string, it's typed in
        // so just override one side
        if (typeof value === 'string') {
            if (balances[value]) {
                setExitToken(balances[value].symbol as string);
            }
            return;
        } else {
            setExitToken(value.symbol);
        }
    };

    if (!currentLpTokens || new BigNumber(currentLpTokens).eq(0)) {
        return (
            <Modal.Body className='connect-wallet-modal'>
                <Container className='error-container'>
                    No LP position in {pairData.token0.symbol}/{pairData.token1.symbol}.
                </Container>
            </Modal.Body>
        );
    }

    const exitOptions = Object.values(balances).filter((balance) => balance.id !== pairData.id);

    return (
        <>
            <Modal.Body className='connect-wallet-modal'>
                <Form.Label className='align-right'>
                    <strong>Available LP Tokens:</strong> {currentLpTokens}
                </Form.Label>
                <Form.Group as={Row}>
                    <Form.Label column sm={6}>
                        <strong>Tokens to Liquidate:</strong>
                    </Form.Label>
                    <Col sm={6}>
                        <FormControl
                            min='0'
                            placeholder='Tokens To Liquidate'
                            value={exitAmount}
                            type='number'
                            onChange={(e) => {
                                setExitAmount(parseFloat(e.target.value));
                            }}
                        />
                    </Col>
                </Form.Group>
                <Form.Group as={Row}>
                    <Form.Label column sm={6}>
                        <strong>Exit Token</strong>
                    </Form.Label>
                    <Col sm={6}>
                        <Combobox
                            data={exitOptions}
                            value={exitToken}
                            textField={renderPairText}
                            itemComponent={({ item: token }) => (
                                <span>
                                    {resolveLogo(token.id)} {token.symbol}
                                </span>
                            )}
                            caseSensitive={false}
                            onChange={handleChange}
                        />
                    </Col>
                </Form.Group>
                <Form.Group as={Row}>
                    <Form.Label column sm={6}>
                        <strong>Expected Payout:</strong>
                    </Form.Label>
                    <Col sm={6}>
                        <p>
                            {resolveLogo(balances[exitToken].id)}{' '}
                            {expectedExitToken !== 'NaN'
                                ? expectedExitToken
                                : 0}{' '}
                            {balances[exitToken].symbol}
                        </p>
                    </Col>
                </Form.Group>
                <br />
                <Card body>
                    <p>
                        <strong>Transaction Settings</strong>
                    </p>
                    {/* <Form.Group as={Row}>
                        <Form.Label column sm={6}>
                            Slippage Tolerance:
                        </Form.Label>
                        <Col sm={2}></Col>
                        <Col sm={4}>
                            <InputGroup>
                                <FormControl
                                    min='0'
                                    className='slippage-tolerance-input'
                                    value={slippageTolerance}
                                    type='number'
                                    onChange={(e) => {
                                        setSlippageTolerance(parseFloat(e.target.value))
                                    }}
                                />
                                <InputGroup.Append>
                                    <InputGroup.Text>%</InputGroup.Text>
                                </InputGroup.Append>
                            </InputGroup>
                        </Col>
                    </Form.Group> */}
                    {gasPrices && (
                        <Form.Group className='transaction-speed-input'>
                            <Form.Label>Transaction Speed:</Form.Label>
                            <ButtonGroup>
                                <Button
                                    variant='outline-dark'
                                    size='sm'
                                    active={
                                        currentGasPrice === gasPrices.standard
                                    }
                                    onClick={() =>
                                        setCurrentGasPrice(gasPrices.standard)
                                    }
                                >
                                    Standard <br />({gasPrices.standard} Gwei)
                                </Button>
                                <Button
                                    variant='outline-dark'
                                    size='sm'
                                    active={currentGasPrice === gasPrices.fast}
                                    onClick={() =>
                                        setCurrentGasPrice(gasPrices.fast)
                                    }
                                >
                                    Fast <br />({gasPrices.fast} Gwei)
                                </Button>
                                <Button
                                    variant='outline-dark'
                                    size='sm'
                                    active={
                                        currentGasPrice === gasPrices.fastest
                                    }
                                    onClick={() =>
                                        setCurrentGasPrice(gasPrices.fastest)
                                    }
                                >
                                    Fastest <br />({gasPrices.fastest} Gwei)
                                </Button>
                            </ButtonGroup>
                        </Form.Group>
                    )}
                </Card>
                {new BigNumber(pairData.reserveUSD).lt(2000000) && (
                    <div className='warn-well'>
                        <p>
                            <strong>Warning: </strong> Low liquidity pairs can
                            experience high slippage at low entry amounts. Be
                            careful when using high slippage tolerance.
                        </p>
                    </div>
                )}
            </Modal.Body>
            <Modal.Footer className='manage-liquidity-modal-footer'>
                <RemoveLiquidityActionButton
                    state={removeLiquidityActionState}
                    onApprove={doApprove}
                    onRemoveLiquidity={doRemoveLiquidity}
                />
            </Modal.Footer>
        </>
    );
}

export default RemoveLiquidity;
