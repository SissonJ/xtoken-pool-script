import { config } from 'dotenv';
import { SecretNetworkClient, } from 'secretjs';
import * as fs from 'fs';

config(); 

const client = new SecretNetworkClient({
  url: process.env.NODE!,
  chainId: process.env.CHAIN_ID!,
});

async function generateConfigs() {
  const response: any = await client.query.compute.queryContract({
    contract_address: process.env.MONEY_MARKET_ADDRESS!,
    code_hash: process.env.MONEY_MARKET_CODE_HASH,
    query: { get_vaults: {} },
  });

  let query = `
    query Pools {
      pools(query: {}) {
        contractAddress
        codeHash
        token0Id
        token1Id
      }
    }
  `;

  const gqlResponse = await fetch(process.env.GRAPHQL!, {
      method: "POST",
      headers: { "Content-Type": "application/json", },
      body: JSON.stringify({ query, })
  });

  const responseBody: any = await gqlResponse.json();
  if (responseBody.errors) {
      console.error("GraphQL Errors:", responseBody.errors);
  }

  if (!responseBody.data?.pools?.length) {
    return;
  }

  query = `
    query Tokens {
      tokens(query: {
        where: {
          flags: {
            has: SNIP20
          }
        }
      }) {
        id
        contractAddress
        codeHash
        symbol
      }
    }
  `;

  const gqlTokenResp = await fetch(process.env.GRAPHQL!, {
      method: "POST",
      headers: { "Content-Type": "application/json", },
      body: JSON.stringify({ query, })
  });
  const tokenBody: any = await gqlTokenResp.json();
  if (tokenBody.errors || tokenBody.data == undefined) {
      console.error("GraphQL Token Errors:", tokenBody.errors);
      return;
  }

  for (const vault of response.data) {
    const xToken = tokenBody.data.tokens.find(
      (token: any) => token.contractAddress === vault.x_token.address
    );
    const token = tokenBody.data.tokens.find(
      (tokenItem: any) => tokenItem.contractAddress === vault.token.address
    );
    const pool = responseBody.data.pools.find(
      (poolItem: any) => poolItem.token0Id === xToken.id 
        || poolItem.token1Id === xToken.id
    );
    if (!pool) {
      continue;
    }
    let env = '';
    env += `XTOKEN_ADDRESS="${vault.x_token.address}"\n`;
    env += `XTOKEN_CODE_HASH="${vault.x_token.code_hash}"\n`;
    env += `BASE_TOKEN_ADDRESS="${vault.token.address}"\n`;
    env += `BASE_TOKEN_CODE_HASH="${vault.token.code_hash}"\n`;
    env += `SHADESWAP_ADDRESS="${pool.contractAddress}"\n`;
    env += `SHADESWAP_CODE_HASH="${pool.codeHash}"\n`;
    env += `ORACLE_KEY="${vault.oracle_key}"\n`;
    env += `DECIMALS=${vault.decimals}\n`;
    const key = token.symbol.toLowerCase().replace('.', '');
    fs.writeFileSync(`./.env.${key}`, env);
  }

}

generateConfigs().catch((error:any) => {console.log(error?.message, new Date());});
