const EXPRESS = require('express')
const PORT = process.env.PORT || 3000
const BCHJS = require("@psf/bch-js")
const MNEMONIC = "pluck vendor erase always juice wash consider fee breeze blossom material gorilla"
const BITBOXSDK = require("bitbox-sdk")

var fs = require("fs")
var https = require("https")

const TOKEN_ID = "d1ffa294850353c35e56d66547b961dc8cb19a63557797caa9e6597b3ef64351"

let app = EXPRESS()
let bchjs = new BCHJS({
  restURL: "https://tapi.fullstack.cash/v3/",
  apiToken: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjVmOWYyMGZmYmI3MjQ3MDAxMmM0ZmNkZSIsImVtYWlsIjoibGFyc19rbG9vc3Rlcm1hbkBvdXRsb29rLmNvbSIsImFwaUxldmVsIjowLCJyYXRlTGltaXQiOjMsImlhdCI6MTYwNDI2NDIyOSwiZXhwIjoxNjA2ODU2MjI5fQ.ujOyvXz23TQ48ZnVrhj61CT_WilVxmpHLj_dI2baEys"
})

let slpjs = require("slpjs")

class Transaction {
  constructor(cash_address, slp_address, change, transaction_code, recipient_address = "", client_confirmations = 0, balance = 0) {
    this.escrow_cash_address = cash_address
    this.escrow_slp_address = slp_address
    this.escrow_change = change
    this.transaction_code = transaction_code
    this.recipient_address = recipient_address
    this.client_confirmations = client_confirmations
    this.balance = balance
  }
}

let pending_transactions = []

async function getNewAddress() {
  return new Promise((resolve, reject) => {
    (async () => {
      let address_object = {
        cash_address: "",
        slp_address: "",
        change: "",
      }

      let root_seed_buffer = await bchjs.Mnemonic.toSeed(MNEMONIC)
      let master_hdnode = bchjs.HDNode.fromSeed(root_seed_buffer, "testnet")

      let found_empty_address = false
      let address_index = 0

      while (found_empty_address === false) {
        try {
          let child_node = bchjs.HDNode.derivePath(master_hdnode, "m/44'/245'/0'")

          address_object.change = bchjs.HDNode.derivePath(child_node, `0/${address_index}`)
          address_object.cash_address = bchjs.HDNode.toCashAddress(address_object.change)
          address_object.slp_address = bchjs.SLP.Address.toSLPAddress(address_object.cash_address)

          try {
            let balances = await bchjs.SLP.Utils.balancesForAddress(address_object.slp_address)

            if (balances === "No balance for this address")
              found_empty_address = true
          } catch (error) {
            reject(error)
          }

        } catch (error) {
          console.log(error)

          reject(error)
        }

        address_index++
      }

      resolve(address_object)
    })()
  })
}

function sleep(ms) {
  return new Promise( (resolve) => {
    setTimeout(resolve, ms)
  })
}

async function getAddressSLPBalance(slp_address) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        waiting_on_confirmations = false

        let balances
        
        do {
          balances = await bchjs.SLP.Utils.balancesForAddress(slp_address)

          if (balances[0].balance == 0) {
            waiting_on_confirmations = true
          } else {
            waiting_on_confirmations = false
          }
          
          await sleep(10000)
        } while (waiting_on_confirmations === true)

        resolve(balances[0].balance)
      } catch (error) {
        reject(error)
      }
    })()
  })
}

function generateTransactionCode() {
  let code_is_unique = true

  let new_transaction_code = ""

  do {
    for (let i = 0; i < 6; i++) {
      let next_number = Math.floor(Math.random() * 10)

      new_transaction_code += next_number 
    }

    let transaction_index = 0
    while (code_is_unique === true && transaction_index < pending_transactions.length) {
      if (pending_transactions[transaction_index].transaction_code === new_transaction_code) {
        code_is_unique = false
      }
    }
  } while (code_is_unique == false)

  return new_transaction_code
}

function findBiggestUtxo (utxos) {
  let largestAmount = 0
  let largestIndex = 0

  for (var i = 0; i < utxos.length; i++) {
    const thisUtxo = utxos[i]

    if (thisUtxo.value > largestAmount) {
      largestAmount = thisUtxo.value
      largestIndex = i
    }
  }

  return utxos[largestIndex]
}

async function sendEscrowBalance(transaction_code) {
  return new Promise((resolve, reject) => {
    (async() => {
      let transaction_index
      for (transaction_index = 0; transaction_index < pending_transactions.length; transaction_index++) {
        if (pending_transactions[transaction_index].transaction_code === transaction_code)
          break;
      }

      try {
        let cash_address = pending_transactions[transaction_index].escrow_cash_address
        let slp_address = pending_transactions[transaction_index].escrow_slp_address
        let key_pair = bchjs.HDNode.toKeyPair(pending_transactions[transaction_index].escrow_change)

        let recipient_address = pending_transactions[transaction_index].recipient_address

        const utxo_data = await bchjs.Electrumx.utxo(cash_address)
        const utxos = utxo_data.utxos

        if (utxos.length === 0) {
          reject("The escrow account \"" + cash_address + "\" does not have any available utxos")
        }

        let slp_utxos = await bchjs.SLP.Utils.tokenUtxoDetails(utxos)
        const bch_utxos = utxos.filter((utxo, index) => {
          const token_utxo = slp_utxos[index]

          if (!token_utxo.isValid)
            return true
        })

        if (bch_utxos.length === 0) {
          reject("The escrow account \"" + cash_address + "\" does not have any available BCH utxos")
        }

        let token_utxos = slp_utxos.filter((utxo, index) => {
          if (
            utxo &&
            utxo.tokenId === TOKEN_ID &&
            utxo.utxoType === "token"
          ) {
            return true
          }
        })

        if (token_utxos.length === 0) {
          reject("The escrow account \"" + cash_address + "\" does not have any available token utxos")
        }

        const fees_utxo = findBiggestUtxo(bch_utxos)

        const slp_object = bchjs.SLP.TokenType1.generateSendOpReturn(
          token_utxos,
          pending_transactions[transaction_index].balance
        )

        const slp_data = slp_object.script

        // CHANGE FOR MAINNET
        let transaction_builder = new bchjs.TransactionBuilder("testnet")

        const original_amount = fees_utxo.value
        transaction_builder.addInput(fees_utxo.tx_hash, fees_utxo.tx_pos)

        for (let i = 0; i < token_utxos.length; i++) {
          transaction_builder.addInput(token_utxos[i].tx_hash, token_utxos[i].tx_pos)
        }

        const transaction_fee = 250

        const remainder_amount = original_amount - transaction_fee - 546 * 2

        if (remainder_amount < 1) {
          reject("The escrow account \"" + cash_address + "\" does not have enough BCH for mining fees")
        }

        transaction_builder.addOutput(slp_data, 0)

        transaction_builder.addOutput(
          bchjs.SLP.Address.toLegacyAddress(recipient_address),
          546
        )

        if (slp_object.outputs > 1) {
          transaction_builder.addOutput(
            bchjs.SLP.Address.toLegacyAddress(slp_address),
            546
          )
        }

        transaction_builder.addOutput(
          bchjs.Address.toLegacyAddress(cash_address),
          remainder_amount
        )

        let redeem_script
        transaction_builder.sign(
          0,
          key_pair,
          redeem_script,
          transaction_builder.hashTypes.SIGHASH_ALL,
          original_amount
        )

        for (let i = 0; i < token_utxos.length; i++) {
          const this_utxo = token_utxos[i]

          transaction_builder.sign(
            1 + i,
            key_pair,
            redeem_script,
            transaction_builder.hashTypes.SIGHASH_ALL,
            this_utxo.value
          )
        }

        const transaction = transaction_builder.build()
        const transaction_hex = transaction.toHex()

        const transaction_id = await bchjs.RawTransactions.sendRawTransaction([transaction_hex])
        console.log("Transaction ID:" + transaction_id)

        resolve(transaction_id)
      } catch (error) {
        reject(error)
      }
    })()
  })
}

app.use(EXPRESS.json())

app.get("/get-address", (req, res) => {
  let transaction_code = generateTransactionCode()

  getNewAddress().then((address_object) => {
    pending_transactions.push(new Transaction(
      address_object.cash_address,
      address_object.slp_address,
      address_object.change,
      transaction_code))

      console.log(address_object)
      console.log(transaction_code)

    res.json({
      "payment_address": address_object.slp_address,
      "transaction_code": transaction_code
    })
  }).catch((error) => {
    console.log(error)

    res.status(500).end()
  })
})

app.post("/link-recipient", (req, res) => {
  let transaction_index

  for (transaction_index = 0; transaction_index < pending_transactions.length; transaction_index++) {
    if (pending_transactions[transaction_index].transaction_code === req.body.transaction_code)
      break;
  }

  pending_transactions[transaction_index].recipient_address = req.body.recipient_address

  getAddressSLPBalance(pending_transactions[transaction_index].escrow_slp_address).then((token_balance) => {
    pending_transactions[transaction_index].balance = token_balance

    res.json({ "escrow_balance": token_balance })
  })
})

app.post("/confirm-transaction", (req, res) => {
  let transaction_index

  console.log(pending_transactions)

  for (transaction_index = 0; transaction_index < pending_transactions.length; transaction_index++) {
    if (pending_transactions[transaction_index].transaction_code === req.body.transaction_code)
      break;
  }

  pending_transactions[transaction_index].client_confirmations += 1

  if (pending_transactions[transaction_index].client_confirmations == 2
    && pending_transactions[transaction_index].recipient_address != "") {
      sendEscrowBalance(pending_transactions[transaction_index].transaction_code).then((transaction_id) => {
        res.json({ "transaction_id": transaction_id })
      })
  } else {
    res.json({ "message": "OK" })
  }
})

https.createServer({
  key: fs.readFileSync('server.key'),
  cert: fs.readFileSync('server.cert')
}, app).listen(PORT, () => {
  console.log("[INF] Senti Pay server listening on port 3000")
})
