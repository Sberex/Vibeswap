const { chromium } = require('playwright-core');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createInterface } = require('node:readline');
(async () => {
  const server = spawn(process.execPath, ['server.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let browser;
  try {
    const lines = createInterface({ input: server.stdout });
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('Vibeswap did not start.')), 5000);
      lines.once('line', line => {
        clearTimeout(timer);
        const match = /listening on port (\d+)/.exec(line);
        if (match) resolve(match[1]);
        else reject(Error(line));
      });
    });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
    const page = await browser.newPage();
    const chain = 'bip122:a771da8e52ee6ad581ed1e9a99825e5b';
    const [A,B,LP] = ['144c654344aa716d6f3abcc1ca90e5641e4e2a7f633bc09fe3baf64585819a49',
      '38fca2d939696061a8f76d4e6b5eecd54e3b4221c846f24a6b279e79952850a5','ab'.repeat(32)];
    await page.addInitScript(({chain,B}) => {
      window.humid = { request: async ({method,params}) => {
        if (method === 'wallet_createSession') {
          if (window.mockHumidDisconnected) throw Error('[pegasus-transport] No handler registered in popup to accept messages with id requestConfirmation');
          return { sessionScopes: {[chain]: { methods:params.optionalScopes[chain].methods,accounts:[chain+':mock'] }} };
        }
        if (method === 'wallet_revokeSession') {
          window.mockHumidDisconnected = true;
          return {revoked:true};
        }
        const req = params.request;
        if (req.method === 'getAddress') return {chainId:chain,address:'tlq1walletmock'};
        if (req.method === 'getBalance') return {chainId:chain,assetId:req.params.assetId,balance:req.params.assetId.endsWith(B)?'702':'100000000'};
        if (req.method === 'getUTXOs') return {chainId:chain,assetId:req.params.assetId,utxos:[{assetId:req.params.assetId}]};
        if (req.method === 'signPset' && !req.params.broadcast) {
          if (window.mockHumidSilent) return new Promise(() => {});
          return {pset:'signed'};
        }
        throw Error('Unexpected Humid request');
      }};
    },{chain,B});
    const actions = [];
    let broadcasts = 0;
    let pool = null;
    await page.route('**/api/*', async route => {
      const req=route.request();
      const path=new URL(req.url()).pathname;
      if(path==='/api/pool') return route.fulfill({json:{pool,fee:'5000'}});
      const body=req.postDataJSON();
      if(path==='/api/prepare') {
        actions.push(body.action);
        assert.equal(body.expectedTxid,pool?.txid??null);
        return route.fulfill({json:{id:'planned',pset:'unsigned',signInputs:[{index:0}]}});
      }
      if(path==='/api/broadcast') {
        broadcasts++;
        assert.equal(body.pset,'signed');
        pool={txid:String(actions.length).repeat(64), lp:LP, assets:[A,B], confirmed:true,reserves:['10000000','100000'],shares:'1000000'};
        return route.fulfill({json:{txid:pool.txid}});
      }
      return route.fulfill({json:{}});
    });
    await page.goto('http://127.0.0.1:' + port);
    await page.getByRole('button',{name:'Connect Humid',exact:true}).click();
    await page.getByText('Wallet details shared.',{exact:true}).waitFor();
    assert.match(await page.locator('#quote').textContent(),/TEST0\.702/);
    await page.getByRole('button',{name:'Liquidity',exact:true}).click();
    await page.getByLabel('Asset A amount').fill('0.01');
    await page.getByLabel('Asset B amount').fill('0.5');
    await page.getByRole('button',{name:'Create pool',exact:true}).click();
    await page.getByText('1'.repeat(64),{exact:true}).waitFor();
    await page.getByRole('button',{name:'Add liquidity',exact:true}).click();
    await page.getByText('2'.repeat(64),{exact:true}).waitFor();
    await page.getByRole('button',{name:'Swap',exact:true}).first().click();
    await page.getByLabel('You pay').fill('0.001');
    await page.locator('#submit').click();
    await page.getByText('3'.repeat(64),{exact:true}).waitFor();
    await page.getByRole('button',{name:'Liquidity',exact:true}).click();
    await page.getByRole('button',{name:'Remove',exact:true}).click();
    await page.getByLabel('LP shares to withdraw').fill('0.001');
    await page.getByRole('button',{name:'Remove liquidity',exact:true}).click();
    await page.getByText('4'.repeat(64),{exact:true}).waitFor();
    assert.deepEqual(actions,['create','add','swap','remove']);
    await page.locator('#wallet-menu summary').click();
    await page.getByRole('button',{name:'Disconnect wallet'}).click();
    await page.getByRole('button',{name:'Connect Humid',exact:true}).click();
    await page.getByRole('button',{name:'Reload to reconnect Humid'}).click();
    await page.getByRole('button',{name:'Connect Humid',exact:true}).click();
    await page.getByText('Wallet details shared.',{exact:true}).waitFor();
    await page.clock.install();
    await page.evaluate(() => { window.mockHumidSilent = true; });
    await page.getByLabel('You pay').fill('0.001');
    await page.locator('#submit').click();
    const transactionStatus = page.locator('#transaction-status');
    await transactionStatus.getByText(/Waiting for Humid/).waitFor();
    await page.getByRole('button',{name:'Liquidity',exact:true}).click();
    assert.match(await transactionStatus.textContent(), /Waiting for Humid/);
    await page.clock.fastForward(240000);
    await transactionStatus.getByText(/stopped before broadcast/).waitFor();
    assert.equal(broadcasts, 4);
    assert.equal(await page.locator('#txid').isHidden(), true);
    console.log('Browser actions, TEST precision, Humid popup recovery, and signing timeout passed with mocked services.');
  } finally {
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, 'exit');
    }
  }
})().catch(error=>{console.error(error);process.exitCode=1});
