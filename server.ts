import { Boom } from '@hapi/boom'
import makeWASocket, { AnyMessageContent, delay, DisconnectReason, fetchLatestBaileysVersion, makeInMemoryStore, useSingleFileAuthState } from "@adiwajshing/baileys";
import MAIN_LOGGER from './Utils/logger'
import express from 'express';
import axios from 'axios';

const app = express();
app.use(express.json());
const port = 8080;
let data = {};
app.post("/", async (req, res) => {
	res.send("The sedulous hyena ate the antelope!");
	data = req.body;
	console.log(data);
	await startSock();
});

app.listen(port, () => {
	return console.log(`server is listening on ${port}`);
});

const logger = MAIN_LOGGER.child({})
logger.level = 'trace'

const useStore = !process.argv.includes('--no-store')
const doReplies = !process.argv.includes('--no-reply')

// the store maintains the data of the WA connection in memory
// can be written out to a file & read from it
const store = useStore ? makeInMemoryStore({ logger }) : undefined
store?.readFromFile('./baileys_store_multi.json')
// save every 10s
setInterval(() => {
	store?.writeToFile('./baileys_store_multi.json')
}, 10_000)

const { state, saveState } = useSingleFileAuthState('./auth_info_multi.json')

// start a connection
const startSock = async () => {
	// fetch latest version of WA Web
	const { version, isLatest } = await fetchLatestBaileysVersion()
	console.log(`using WA v${version.join('.')}, isLatest: ${isLatest}`)

	const sock = makeWASocket({
		version,
		logger,
		printQRInTerminal: true,
		auth: state,
		// implement to handle retries
		getMessage: async key => {
			return {
				conversation: 'hello'
			}
		}
	})

	store?.bind(sock.ev)

	const sendMessageWTyping = async (msg: AnyMessageContent, jid: string) => {
		await sock.presenceSubscribe(jid)
		await delay(500)

		await sock.sendPresenceUpdate('composing', jid)
		await delay(2000)

		await sock.sendPresenceUpdate('paused', jid)

		await sock.sendMessage(jid, msg)
	}

	// sock.ev.on('chats.set', item => console.log(`recv ${item.chats.length} chats (is latest: ${item.isLatest})`))
	// sock.ev.on('messages.set', item => console.log(`recv ${item.messages.length} messages (is latest: ${item.isLatest})`))
	// sock.ev.on('contacts.set', item => console.log(`recv ${item.contacts.length} contacts`))

	sock.ev.on('messages.upsert', async m => {
		console.log(JSON.stringify(m, undefined, 2))

		const URL = "http://localhost:5005/webhooks/rest/webhook"
		const msg = m.messages[0]
		if (!msg.key.fromMe && m.type === 'notify' && doReplies) {
			console.log('replying to', m.messages[0].key.remoteJid)
			let resp = "";
			if (msg && msg.key && msg.key.remoteJid && msg.message && msg.message.conversation) {
				if (msg.key.participant && msg.key.id)
					await sock!.sendReadReceipt(msg.key.remoteJid, msg.key.participant, [msg.key.id])
				axios.post(URL, {
					sender: msg.key.remoteJid,
					message: msg.message.conversation
				})
					.then(async (response) => {
						resp = response.data[0].text;
						console.log("Foo");
						console.log(response.data);
						console.log("Bar");
						if (msg && msg.key && msg.key.remoteJid)
							await sendMessageWTyping({ text: resp }, msg.key.remoteJid)
					}, (error) => {
						console.log(error);
					});
			}
		}
	})

	sock.ev.on('messages.update', m => console.log(m))
	// sock.ev.on('message-receipt.update', m => console.log(m))
	// sock.ev.on('presence.update', m => console.log(m))
	// sock.ev.on('chats.update', m => console.log(m))
	// sock.ev.on('contacts.upsert', m => console.log(m))

	sock.ev.on('connection.update', (update) => {
		const { connection, lastDisconnect } = update
		if (connection === 'close') {
			// reconnect if not logged out
			if ((lastDisconnect && lastDisconnect.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut) {
				startSock()
			} else {
				console.log('Connection closed. You are logged out.')
			}
		}

		console.log('connection update', update)
	})
	// listen for when the auth credentials is updated
	sock.ev.on('creds.update', saveState)

	return sock
}

startSock()