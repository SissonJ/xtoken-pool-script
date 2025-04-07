import * as fs from 'fs';
import { config } from 'dotenv';
import {
 MsgExecuteContract, SecretNetworkClient, 
 Wallet
} from 'secretjs';

config({ path: [`./.env.${process.argv[2]}`, './.env'] }); 

enum QUERY_TYPE {
  BALANCE = 'balance',
  TOKEN_INFO = 'token_info',
  PAIR = 'pair',
  VAULT = 'vault',
  ORACLE = 'oracle',
}

type BatchQueryResponse = {
  batch: {
    block_height: number,
    responses: {
      id: string,
      contract: {
        address: string,
        code_hash: string,
      },
      response: {
        response: string,
      },
    }[],
  },
}

type SwapSimResponse = {
  swap_simulation: {
    result: {
      return_amount: string,
    },
  },
}

type Results = {
  [key: string]: {
    start?: number,
    lastUpdate?: number,
    lastAttempt?: number,
    totalAttempts: number,
    successfulAttempts: number,
    failedAttempts: number,
    failedQueries: number,
    queryLength: number[],
    profit?: number[],
    executeLength?: number,
    lastFailed?: number,
    hasNotified?: boolean,
  },
}

const client = new SecretNetworkClient({
  url: process.env.NODE!,
  chainId: process.env.CHAIN_ID!,
  wallet: new Wallet(process.env.ARB_V4!),
  walletAddress: process.env.ARB_V4_ADDRESS!,
  encryptionSeed: Uint8Array.from(process.env.ENCRYPTION_SEED!.split(',').map(Number)),
});

const encodeJsonToB64 = (toEncode:any) : string => Buffer.from(JSON.stringify(toEncode), 'utf8').toString('base64');

const decodeB64ToJson = (encodedData: string) => JSON.parse(Buffer.from(encodedData, 'base64').toString('utf8'));


const getCentralTime = (date: Date): string => {
  return date.toLocaleString(
    'en-US', 
    {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }
  ).replace(
    /(\d+)\/(\d+)\/(\d+)/, 
    '$3-$1-$2'
  );
};

const logger = {
  error: (msg: string, time: Date, error?: any) => {
    console.error(`[${getCentralTime(time)} ${process.argv[2]} ERROR] ${msg}`, error);
  },
  info: (msg: string, time: Date) => {
    console.log(`[${getCentralTime(time)} ${process.argv[2]} INFO] ${msg}`);
  }
};

async function main() {
  if(process.argv[2] === undefined) {
    throw new Error('Arugments are undefined');
  }
  if (!fs.existsSync(`./results${process.argv[2]}.txt`)) {
    const initialState: Results = {
      [process.argv[2]]: {
        totalAttempts: 0,
        successfulAttempts: 0,
        failedAttempts: 0,
        failedQueries: 0,
        queryLength: [],
        profit: [],
      }
    };
    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify(initialState));
  }

  const resultsUnparsed = fs.readFileSync(`./results${process.argv[2]}.txt`, 'utf-8');
  const resultsFull: Results = JSON.parse(resultsUnparsed);
  const results: Results[string] = resultsFull[process.argv[2]];

  const now = new Date();
  if(now.getTime() - (results.lastFailed ?? 0) < 7_200_000 ) {
    if(!results.hasNotified) {
      logger.info(`On cooldown from last failed`, now);
    }
    results.hasNotified = true;
    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify({
      ...resultsFull,
      [process.argv[2]]: { ...results, }
    }, null, 2));
    return;
  }
  results.hasNotified = false;

 if (results.start === undefined 
   ||  now.getTime() - (results.lastUpdate ?? 0) > 7_200_000) {
    results.lastUpdate = now.getTime();
    if(results.start === undefined) {
      results.start = now.getTime();
    }
    const queryLength = results.queryLength.reduce((acc, curr) => acc + curr, 0) 
      / results.queryLength.length;
    const profitArray = results.profit ?? [];
    const profit = profitArray.reduce((acc, curr) => acc + curr, 0) 
      / profitArray.length;
    results.profit = [];
    logger.info(
      `Bot running for ${Math.floor((now.getTime() - results.start) / 3_600_000)} hours` +
      `  Total Attempts: ${results.totalAttempts}` +
      `  Successful: ${results.successfulAttempts}` +
      `  Failed: ${results.failedAttempts}` +
      `  Average Query Length: ${queryLength?.toFixed(3)}` +
      `  Average Profit: ${profit?.toFixed(3)}`,
      now
    );
  }
  

  const queryMsg = {
    batch: {
      queries: [
        {
          id: encodeJsonToB64(QUERY_TYPE.ORACLE),
          contract: {
            address: process.env.ORACLE_ADDRESS,
            code_hash: process.env.ORACLE_CODE_HASH,
          },
          query: encodeJsonToB64({ get_price:{ key:process.env.ORACLE_KEY } }),
        },
        {
          id: encodeJsonToB64(QUERY_TYPE.BALANCE),
          contract: {
            address: process.env.MONEY_MARKET_ADDRESS,
            code_hash: process.env.MONEY_MARKET_CODE_HASH,
          },
          query: encodeJsonToB64({ 
            user_position: { 
              authentication: { 
                permit: JSON.parse(
                  process.env.SHADE_MASTER_PERMIT!
                ) 
              } 
            } 
          }),
        },
        {
          id: encodeJsonToB64(QUERY_TYPE.TOKEN_INFO),
          contract: {
            address: process.env.XTOKEN_ADDRESS,
            code_hash: process.env.XTOKEN_CODE_HASH,
          },
          query: encodeJsonToB64({ token_info: {} }),
        }, 
        {
          id: encodeJsonToB64(QUERY_TYPE.PAIR),
          contract: {
            address: process.env.SHADESWAP_ADDRESS,
            code_hash: process.env.SHADESWAP_CODE_HASH,
          },
          query: encodeJsonToB64({ get_pair_info: {} }),
        },
        {
          id: encodeJsonToB64(QUERY_TYPE.VAULT),
          contract: {
            address: process.env.MONEY_MARKET_ADDRESS,
            code_hash: process.env.MONEY_MARKET_CODE_HASH,
          },
          query: encodeJsonToB64({ get_vault: { token: process.env.BASE_TOKEN_ADDRESS , } }),
        }
      ],
    }
  };

  const beforeQuery = new Date().getTime();
  let response;
  try {
    response = await client.query.compute.queryContract({
      contract_address: process.env.BATCH_QUERY_CONTRACT!,
      code_hash: process.env.BATCH_QUERY_HASH,
      query: queryMsg,
    }) as BatchQueryResponse;
  } catch (e: any) {
    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify({
      ...resultsFull,
      [process.argv[2]]: { ...results, }
    }, null, 2));
    if(e.message.includes('invalid json response')) {
      results.failedQueries += 1;
      return;
    }
    throw new Error(e);
  }

  if(response === undefined) {
    results.failedQueries += 1;
    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify({
      ...resultsFull,
      [process.argv[2]]: { ...results, }
    }, null, 2));
    return;
  }
  
  const queryLength = (new Date().getTime() - beforeQuery) / 1000;
  results.queryLength.push(queryLength);
  if(results.queryLength.length > 100) {
    // Keep the last 10 query lengths for average calculation
    results.queryLength.shift();
  }

  let xTokenSupply;
  let baseTokenAmount;
  let xTokenAmount;
  let maxBorrowUsd;
  let vaultTotalAssets;
  let supplyCap;
  let price;
  response.batch.responses.forEach((encryptedResp) => {
    const id = decodeB64ToJson(encryptedResp.id);
    const responseData = decodeB64ToJson(encryptedResp.response.response);
    if(id === QUERY_TYPE.ORACLE) {
      price = Number(responseData.data.rate / 10**18);
    } else if(id === QUERY_TYPE.TOKEN_INFO) {
      xTokenSupply = Number(responseData.token_info.total_supply);
    } else if(id === QUERY_TYPE.BALANCE) {
      maxBorrowUsd = Number(responseData.max_borrow_value);
    } else if(id === QUERY_TYPE.PAIR) {
      baseTokenAmount = Number(responseData.get_pair_info.amount_0);
      xTokenAmount = Number(responseData.get_pair_info.amount_1);
    } else if(id === QUERY_TYPE.VAULT) {
      const loanable = responseData.loanable;
      const lent = responseData.lent_amount;
      const interestPaid = responseData.lifetime_interest_paid;
      const interestOwed = responseData.lifetime_interest_owed;
      vaultTotalAssets = Number(loanable) + Number(lent) + 
        (Number(interestOwed) - Number(interestPaid));
      supplyCap = Number(responseData.max_supply) - vaultTotalAssets;
    }
  });

  if(baseTokenAmount === undefined 
    || xTokenAmount === undefined 
    || xTokenSupply === undefined
    || vaultTotalAssets === undefined
    || isNaN(vaultTotalAssets)
    || maxBorrowUsd === undefined
    || supplyCap === undefined
    || price === undefined
  ) {
    throw new Error('Missing required data from batch query response');
  }

  const liquidityCap = baseTokenAmount * 0.05;
  const borrowCap = Math.floor(((maxBorrowUsd * 0.98) / price) 
    * 10**Number(process.env.DECIMALS!));
  const tradeAmount = Math.min(liquidityCap, borrowCap);
  
  let swapFirstResponse;
  try {
    swapFirstResponse = await client.query.compute.queryContract({
      contract_address: process.env.SHADESWAP_ADDRESS!,
      code_hash: process.env.SHADESWAP_CODE_HASH,
      query: {
        swap_simulation: {
          offer: { 
            amount: tradeAmount.toFixed(0), 
            token: {
              custom_token: {
                 contract_addr: process.env.BASE_TOKEN_ADDRESS,
                 token_code_hash: process.env.BASE_TOKEN_CODE_HASH,
              }
            }
          } 
        }, 
      },
    }) as SwapSimResponse;
  } catch (e: any) {
    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify({
      ...resultsFull,
      [process.argv[2]]: { ...results, }
    }, null, 2));
    if(e.message.includes('invalid json response')) {
      results.failedQueries += 1;
      return;
    }
    throw new Error(e);
  }
  let swapFirstSecondActionInput;
  if(swapFirstResponse?.swap_simulation?.result?.return_amount === undefined) {
    results.failedQueries += 1;
    swapFirstSecondActionInput = 0;
  } else {
    swapFirstSecondActionInput = Number(
      swapFirstResponse.swap_simulation.result.return_amount
    ) * 0.99999;
  }
  const swapFirstFinalAmount = ((swapFirstSecondActionInput
    * vaultTotalAssets) / xTokenSupply).toFixed(0);
  const swapFirstResult = Number(swapFirstFinalAmount);
  // MINT FIRST
  let mintFirstTradeAmount = tradeAmount;
  if(supplyCap < tradeAmount) {
    mintFirstTradeAmount = supplyCap > 0 ? supplyCap : 0;
  }
  const xTokenMintAmount = ((mintFirstTradeAmount * xTokenSupply) / vaultTotalAssets);
  const mintFirstSecondActionInput = xTokenMintAmount;

  let swapSecondResponse;
  try {
    swapSecondResponse = await client.query.compute.queryContract({
      contract_address: process.env.SHADESWAP_ADDRESS!,
      code_hash: process.env.SHADESWAP_CODE_HASH,
      query: {
        swap_simulation: {
          offer: {
             amount: mintFirstSecondActionInput.toFixed(0), 
             token: {
               custom_token: {
                 contract_addr: process.env.XTOKEN_ADDRESS,
                 token_code_hash: process.env.XTOKEN_CODE_HASH,
               }
             }
          } 
        }, 
      },
    }) as SwapSimResponse;
  } catch (e: any) {
    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify({
      ...resultsFull,
      [process.argv[2]]: { ...results, }
    }, null, 2));
    if(e.message.includes('invalid json response')) {
      results.failedQueries += 1;
      return;
    }
    throw new Error(e);
  }
  let swapSecondFinalAmount;
  if(swapSecondResponse?.swap_simulation?.result?.return_amount === undefined) {
    results.failedQueries += 1;
    swapSecondFinalAmount = 0;
  } else {
    swapSecondFinalAmount = Number(swapSecondResponse.swap_simulation.result.return_amount)
     * 0.99999;
  }
  const mintFirstResult = swapSecondFinalAmount;

  const swapFirstProfit = (swapFirstResult - tradeAmount) 
    * price / 10 ** Number(process.env.DECIMALS!);
  const mintFirstProfit = (mintFirstResult - mintFirstTradeAmount) 
    * price / 10 ** Number(process.env.DECIMALS!);
  let swapFirst = false;
  let profit = mintFirstProfit;
  let result = mintFirstResult;
  let secondActionInput = mintFirstSecondActionInput;
  if(swapFirstProfit > mintFirstProfit) {
    profit = swapFirstProfit;
    result = swapFirstResult;
    secondActionInput = swapFirstSecondActionInput;
    swapFirst = true;
  }
  results.profit ? results.profit.push(profit): results.profit = [profit];
  if(profit < Number(process.env.MINIMUM_PROFIT)) {

    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify({
      ...resultsFull,
      [process.argv[2]]: { ...results, }
    }, null, 2));
    return;
  }
  results.totalAttempts += 1;
  const beforeExeucte = new Date().getTime();

  let firstMsg;
  let secondMsg;
  if(swapFirst) {
    firstMsg = {
      send: {
        recipient: process.env.SHADESWAP_ADDRESS,
        recipient_code_hash: process.env.SHADESWAP_CODE_HASH,
        amount: tradeAmount.toFixed(0),
        msg: encodeJsonToB64({ swap_tokens:{ expected_return: secondActionInput.toFixed(0), } })
      }
    };
    secondMsg = {
      send: {
        recipient: process.env.MONEY_MARKET_ADDRESS,
        recipient_code_hash: process.env.MONEY_MARKET_CODE_HASH,
        amount: secondActionInput.toFixed(0),
        msg: encodeJsonToB64({ withdraw_supply: {} })
      }
    };
  }else {
    firstMsg = {
      send: {
        recipient: process.env.MONEY_MARKET_ADDRESS,
        recipient_code_hash: process.env.MONEY_MARKET_CODE_HASH,
        amount: tradeAmount.toFixed(0),
        msg: encodeJsonToB64({ supply: {} })
      }
    };
    secondMsg = {
      send: {
        recipient: process.env.SHADESWAP_ADDRESS,
        recipient_code_hash: process.env.SHADESWAP_CODE_HASH,
        amount: secondActionInput.toFixed(0),
        msg: encodeJsonToB64({ swap_tokens:{ expected_return: String(result), } })
      }
    };
  }

  const msgs = [
    new MsgExecuteContract({
      sender: client.address, 
      contract_address: process.env.MONEY_MARKET_ADDRESS!,
      code_hash: process.env.MONEY_MARKET_CODE_HASH,
      msg: { 
        borrow:{
          token: process.env.BASE_TOKEN_ADDRESS, // Borrow base token to swap
          amount: tradeAmount.toFixed(0), // The amount we want to borrow
        } 
      }, 
      sent_funds: [],
    }),
    new MsgExecuteContract({
      sender: client.address, 
      contract_address: process.env.BASE_TOKEN_ADDRESS!,
      code_hash: process.env.BASE_TOKEN_CODE_HASH,
      msg: firstMsg, 
      sent_funds: [],
    }),
    new MsgExecuteContract({
      sender: client.address, 
      contract_address: process.env.XTOKEN_ADDRESS!,
      code_hash: process.env.XTOKEN_CODE_HASH,
      msg: secondMsg, 
      sent_funds: [],
    }),
    new MsgExecuteContract({
      sender: client.address, 
      contract_address: process.env.BASE_TOKEN_ADDRESS!,
      code_hash: process.env.BASE_TOKEN_CODE_HASH,
      msg: {
        send: {
          recipient: process.env.MONEY_MARKET_ADDRESS,
          recipient_code_hash: process.env.MONEY_MARKET_CODE_HASH,
          amount: result.toFixed(0),
          msg: encodeJsonToB64({ repay: {} })
        } 
      }, 
      sent_funds: [],
    }),
  ]

  const executeResponse = await client.tx.broadcast(
    msgs,
    {
      gasLimit: 4_000_000,
      feeDenom: 'uscrt',
    },
  )
  if(executeResponse?.transactionHash !== undefined) {
    fs.appendFile('../transactions.txt', 
      `${now.getTime()},${executeResponse.transactionHash},xToken\n`, 
      (err) => {
        if (err) logger.error('Failed to append transaction hash', now, err);
      }
    );
  }
  if(executeResponse.code === 0) {
    logger.info(`ARBITRAGE ATTEMPT SUCCESSFUL - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.jsonLog, null, 2), now);
    results.successfulAttempts += 1;
  } else {
    logger.info(`ARBITRAGE ATTEMPT FAILED - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.rawLog), now);
    results.lastFailed = now.getTime();
    results.failedAttempts += 1;
  }
  const executeLength = (new Date().getTime() - beforeExeucte) / 1_000;
  results.executeLength = results.executeLength 
    ? (results.executeLength + executeLength) / 2 
    : executeLength;

  fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify({
    ...resultsFull,
    [process.argv[2]]: { ...results, }
  }, null, 2));
}

main().catch((error:any) => {logger.error(error?.message, new Date());});

