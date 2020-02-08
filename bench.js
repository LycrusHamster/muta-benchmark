const autocannon = require("autocannon");
const ora = require("ora");
const Table = require("cli-table3");
const logger = require("./logger");
const { utils } = require("muta-sdk");
const randomBytes = require("randombytes");
const md5 = require("md5");

function round(x) {
  return parseFloat(Math.round(x * 100) / 100).toFixed(2);
}

const query = `mutation ( $inputRaw: InputRawTransaction! $inputEncryption: InputTransactionEncryption! ) { sendTransaction(inputRaw: $inputRaw, inputEncryption: $inputEncryption) }`;

let currentTime = Date.now();
let flushTime = null;

async function runMain(assetBenchProducer, workers, options) {
  let errorCount = 0;

  function getBody() {
    return assetBenchProducer.produceRequestBody();
  }

  await assetBenchProducer.start();

  return new Promise((resolve, reject) => {
    const instance = autocannon(
      {
        ...options,
        setupClient(client) {
          client.setBody(getBody());
        }
      },
      finishedBench
    );

    autocannon.track(instance);

    instance.on("response", function(client, statusCode, returnBytes, responseTime) {
      const res = client.parser.chunk.toString();
      const isError = res.includes("error");
      if (isError) {
        logger.error(res);
        errorCount++;
      }
      client.setBody(getBody());
    });

    instance.on("done", async function({ start, duration }) {
      for (const worker of workers) {
        worker.process.kill();
      }
      const spin = ora("TPS is calculating ").start();
      const { blockUsage, transferProcessed, blocks } = await assetBenchProducer.end();
      spin.stop();

      const txCount = transferProcessed;
      const blockCount = blockUsage;

      const balanceTable = new Table({ head: ["", "balance", "block height"] });
      balanceTable.push(
        { init: [assetBenchProducer.startBalance, assetBenchProducer.startBlock] },
        { done: [assetBenchProducer.endBalance, assetBenchProducer.endBlock] }
      );

      console.log("block_id \t\t count \t\t\t round");
      Object.entries(blocks)
        .sort((l, r) => Number(l[0]) - Number(r[0]))
        .forEach(([id, info]) => {
          console.log(`${id} \t\t\t ${info.transactionsCount} \t\t\t ${info.round}`);
        });

      console.log("TPS:");
      console.log(balanceTable.toString());

      console.log(`${round(txCount / blockCount)} tx/block`);
      console.log(`${round(duration / blockCount)} sec/block`);
      console.log(`${round(txCount / duration)} tx/sec`);
    });

    function finishedBench(err) {
      if (err) reject(err);
      else resolve({ errorCount });
    }
  });
}

function runWorker() {
  let errorCount = 0;

  const workerData = JSON.parse(process.env.WORKER_DATA);
  const options = JSON.parse(process.env.OPTIONS);

  flushTime = workerData.flushTime * 1000;

  const payload = JSON.stringify({ asset_id: workerData.assetId, to: workerData.to, value: 1 });

  function getBody() {
    const nonce = Buffer.from(md5(randomBytes(16).toString("hex") + "" + currentTime)).toString("hex");

    if (Date.now() - currentTime > flushTime) {
      currentTime = Date.now();
    }
    const variables = utils.signTransaction(
      {
        serviceName: "asset",
        method: "transfer",
        payload,
        timeout: workerData.timeout,
        nonce: `0x${nonce}`,
        chainId: `${workerData.chainId}`,
        cyclesPrice: "0x01",
        cyclesLimit: "0x5208"
      },
      Buffer.from(workerData.privateKey, "hex")
    );

    const tx = JSON.stringify({
      query,
      variables
    });

    return tx;
  }

  const instance = autocannon(
    {
      ...options,
      setupClient(client) {
        client.setBody(getBody());
      }
    },
    finishedBench
  );

  autocannon.track(instance);

  instance.on("response", function(client, statusCode, returnBytes, responseTime) {
    const res = client.parser.chunk.toString();
    const isError = res.includes("error");
    if (isError) {
      logger.error(res);
      errorCount++;
    }
    client.setBody(getBody());
  });

  function finishedBench(err) {
    if (err) {
      process.exit(1);
    }
    process.exit(0);
  }
}

exports.runWorker = runWorker;
exports.runMain = runMain;
