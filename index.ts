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
    totalAttempts: number,
    successfulAttempts: number,
    failedAttempts: number,
    queryLength?: number,
    executeLength?: number,
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
      }
    };
    fs.writeFileSync(`./results${process.argv[2]}.txt`, JSON.stringify(initialState));
  }

  const resultsUnparsed = fs.readFileSync(`./results${process.argv[2]}.txt`, 'utf-8');
  const resultsFull: Results = JSON.parse(resultsUnparsed);
  const results: Results[string] = resultsFull[process.argv[2]];

  // Something with logging time
  const now = new Date();
  const start = results.start ?? now.getTime();
  if(results.start === undefined) {
    results.start = now.getTime();
  }

  if ((now.getTime() - start > 7_200_000 
    && (now.getTime() - start) % 7_200_000 < 10_000) 
    || now.getTime() - start < 15_000
  ) {
    logger.info(
      `Bot running for ${Math.floor((now.getTime() - start) / 3_600_000)} hours` +
      `  Total Attempts: ${results.totalAttempts}` +
      `  Successful: ${results.successfulAttempts}` +
      `  Failed: ${results.failedAttempts}` +
      `  Average Query Length: ${results.queryLength?.toFixed(3)}` +
      `  Average Execute Length: ${results.executeLength?.toFixed(3) ?? -1}`,
      now
    );
  }
  

  const queryMsg = {
    batch: {
      queries: [
        {
          id: encodeJsonToB64(QUERY_TYPE.BALANCE),
          contract: {
            address: process.env.BASE_TOKEN_ADDRESS,
            code_hash: process.env.BASE_TOKEN_CODE_HASH,
          },
          query: encodeJsonToB64({
            balance: {
              address: process.env.ARB_V4_ADDRESS,
              key: process.env.BASE_TOKEN_VIEWING_KEY,
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
  const response = await client.query.compute.queryContract({
    contract_address: process.env.BATCH_QUERY_CONTRACT!,
    code_hash: process.env.BATCH_QUERY_HASH,
    query: queryMsg,
  }) as BatchQueryResponse;
  
  const queryLength = (new Date().getTime() - beforeQuery) / 1_000;
  results.queryLength = results.queryLength ? (results.queryLength + queryLength) / 2 : queryLength;

  let xTokenSupply;
  let baseTokenAmount;
  let xTokenAmount;
  let walletBalance;
  let vaultTotalAssets;
  let supplyCap;
  response.batch.responses.forEach((encryptedResp) => {
    const id = decodeB64ToJson(encryptedResp.id);
    const responseData = decodeB64ToJson(encryptedResp.response.response);
    if(id === QUERY_TYPE.TOKEN_INFO) {
      xTokenSupply = Number(responseData.token_info.total_supply);
    } else if(id === QUERY_TYPE.BALANCE) {
      walletBalance = Number(responseData.balance.amount);
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
    || walletBalance === undefined
    || supplyCap === undefined
  ) {
    throw new Error('Missing required data from batch query response');
  }

  const swapRate = baseTokenAmount / xTokenAmount;
  let marketRate = 0;
  if (vaultTotalAssets > 0) {
    marketRate = xTokenSupply / vaultTotalAssets;
  }
  const percentOfPool = baseTokenAmount * 0.01;
  let tradeAmount = walletBalance > percentOfPool ? percentOfPool : walletBalance;

  let swapFirst = false;
  let secondActionInput = 0;
  let result = 0;
  if (swapRate < marketRate) { // Swap First
    swapFirst = true;

    const swapFirstResponse = await client.query.compute.queryContract({
      contract_address: process.env.SHADESWAP_ADDRESS!,
      code_hash: process.env.SHADESWAP_CODE_HASH,
      query: {
        swap_simulation: {
          offer: { 
            amount: String(tradeAmount), 
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
    secondActionInput = Number(swapFirstResponse.swap_simulation.result.return_amount);
    const swapFirstFinalAmount = ((Number(swapFirstResponse.swap_simulation.result.return_amount) 
      * vaultTotalAssets) / xTokenSupply).toFixed(0);
    result = Number(swapFirstFinalAmount);
  } else { // Mint first
    if(supplyCap < tradeAmount) {
      tradeAmount = supplyCap;
    }
    const xTokenMintAmount = ((tradeAmount * xTokenSupply) / vaultTotalAssets).toFixed(0);
    secondActionInput = Number(xTokenMintAmount);
    const swapSecondResponse = await client.query.compute.queryContract({
      contract_address: process.env.SHADESWAP_ADDRESS!,
      code_hash: process.env.SHADESWAP_CODE_HASH,
      query: {
        swap_simulation: {
          offer: {
             amount: xTokenMintAmount, 
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
    const swapSecondFinalAmount = Number(swapSecondResponse.swap_simulation.result.return_amount)
    result = swapSecondFinalAmount;
  }

  if((result - tradeAmount) < Number(process.env.MINIMUM_PROFIT)) {
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
        amount: String(walletBalance),
        msg: encodeJsonToB64({ swap_tokens:{ expected_return: String(secondActionInput), } })
      }
    };
    secondMsg = {
      send: {
        recipient: process.env.MONEY_MARKET_ADDRESS,
        recipient_code_hash: process.env.MONEY_MARKET_CODE_HASH,
        amount: String(secondActionInput),
        msg: encodeJsonToB64({ withdraw_supply: {} })
      }
    };
  }else {
    firstMsg = {
      send: {
        recipient: process.env.MONEY_MARKET_ADDRESS,
        recipient_code_hash: process.env.MONEY_MARKET_CODE_HASH,
        amount: String(walletBalance),
        msg: encodeJsonToB64({ supply: {} })
      }
    };
    secondMsg = {
      send: {
        recipient: process.env.SHADESWAP_ADDRESS,
        recipient_code_hash: process.env.SHADESWAP_CODE_HASH,
        amount: String(secondActionInput),
        msg: encodeJsonToB64({ swap_tokens:{ expected_return: String(result), } })
      }
    };
  }

  const msgs = [
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
    })
  ]

  const executeResponse = await client.tx.broadcast(
    msgs,
    {
      gasLimit: 2_000_000,
      feeDenom: 'uscrt',
    },
  )
  if(executeResponse.code === 0) {
    logger.info(`ARBITRAGE ATTEMPT SUCCESSFUL - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.jsonLog), now);
    results.successfulAttempts += 1;
  } else {
    logger.info(`ARBITRAGE ATTEMPT FAILED - ${executeResponse.transactionHash}`, now);
    logger.info(JSON.stringify(executeResponse.jsonLog), now);
    logger.info(JSON.stringify(executeResponse.rawLog), now);
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

try {
  Promise.resolve(main());
} catch(error: any) {
  logger.error(`Error in main execution`, new Date(), error);
}

