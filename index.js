const moment = require("moment");
const axios = require("axios");
const uuid = require("uuid");
const cron = require("node-cron");
require("dotenv").config();

const { CLIENT_ID, CLIENT_SECRET, API_USER, API_PASSWORD, UPTIME_KUMA_URL, UPTIME_KUMA_MONITOR_ID, CRON_SCHEDULE, ENABLE_CRON, TZ } = process.env;
async function createSnapshots(CLIENT_ID, CLIENT_SECRET, API_USER, API_PASSWORD, UPTIME_KUMA_URL, UPTIME_KUMA_MONITOR_ID) {
	const TRACE_ID = uuid.v4();

	const ACCESS_TOKEN = await axios
		.post(
			"https://auth.contabo.com/auth/realms/contabo/protocol/openid-connect/token",
			new URLSearchParams({
				client_id: CLIENT_ID,
				client_secret: CLIENT_SECRET,
				username: API_USER,
				password: API_PASSWORD,
				grant_type: "password",
			})
		)
		.then((response) => response.data.access_token)
		.catch((error) => console.error(error.response.data));

	const instances = await axios
		.get("https://api.contabo.com/v1/compute/instances", {
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${ACCESS_TOKEN}`,
				"x-trace-id": TRACE_ID,
				"x-request-id": uuid.v4(),
			},
		})
		.then((response) => response.data.data.map((instance) => instance))
		.catch((error) => console.error(error.response.data));

	if (!instances) return process.exit(1);

	instances.forEach(async (instance) => {
		const instanceId = instance.instanceId;
		const snapshotData = {
			name: `snapshot-${moment().format("YYYY-MM-DD-HH-mm-ss")}`,
			description: `Automated snapshot created at ${moment().format("DD.MM.YYYY HH:mm:ss")}`,
		};

		let snapshot;

		// Attempt 1 - Create a snapshot
		await axios
			.post(`https://api.contabo.com/v1/compute/instances/${instanceId}/snapshots`, snapshotData, {
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${ACCESS_TOKEN}`,
					"x-trace-id": TRACE_ID,
					"x-request-id": uuid.v4(),
				},
			})
			.then(async (response) => {
				snapshot = response.data.data;
				await notifyUptimeKuma(UPTIME_KUMA_URL, UPTIME_KUMA_MONITOR_ID);
			})
			.catch(async (error) => {
				// Attempt failed - Check if the error is due to the CURRENT snapshot limit
				if (error.response.status !== 402) {
					// No - Log the error and return
					return console.error(error.response.data);
				}
				// Check if the error is due to the TOTAL snapshot limit
				if (error.response.data.message === "Total snapshots exceed the total max limit of 0 snapshots") return (snapshot = error.response.data);

				// Attempt 2 - Get the list of snapshots
				const snapshots = await axios
					.get(`https://api.contabo.com/v1/compute/instances/${instanceId}/snapshots`, {
						headers: {
							"Content-Type": "application/json",
							Authorization: `Bearer ${ACCESS_TOKEN}`,
							"x-trace-id": TRACE_ID,
							"x-request-id": uuid.v4(),
						},
					})
					.then((response) => response.data.data);
				// console.log(snapshots);
				// Get the oldest snapshot and delete it
				const oldestSnapshot = snapshots.sort((a, b) => moment(a.createdDate).diff(moment(b.createdDate)))[0];
				console.log(`Deleting snapshot ${oldestSnapshot.snapshotId} for instance ${instanceId}`, oldestSnapshot);
				await axios
					.delete(`https://api.contabo.com/v1/compute/instances/${instanceId}/snapshots/${oldestSnapshot.snapshotId}`, {
						headers: {
							Authorization: `Bearer ${ACCESS_TOKEN}`,
							"x-trace-id": TRACE_ID,
							"x-request-id": uuid.v4(),
						},
					})
					.then(async () => {
						// Attempt 3 - Create a snapshot
						await axios
							.post(`https://api.contabo.com/v1/compute/instances/${instanceId}/snapshots`, snapshotData, {
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${ACCESS_TOKEN}`,
									"x-trace-id": TRACE_ID,
									"x-request-id": uuid.v4(),
								},
							})
							.then(async (response) => {
								snapshot = response.data.data;
								await notifyUptimeKuma(UPTIME_KUMA_URL, UPTIME_KUMA_MONITOR_ID);
							})
							.catch((error) => console.error(error.response.data));
					})
					.catch((error) => console.error(error.response.data));
			}, {});
		if (snapshot.statusCode === 402) {
			console.log(`Skipped creating snapshot for instance ${instanceId} due to the snapshot limit`, snapshot);
			return;
		}
		console.log(`Snapshot created for instance ${instanceId}`, snapshot);
	});
}
createSnapshots(CLIENT_ID, CLIENT_SECRET, API_USER, API_PASSWORD, UPTIME_KUMA_URL, UPTIME_KUMA_MONITOR_ID);
let cronJob = cron.schedule(CRON_SCHEDULE || "0 0 0 * * *", () =>
	createSnapshots(CLIENT_ID, CLIENT_SECRET, API_USER, API_PASSWORD, UPTIME_KUMA_URL, UPTIME_KUMA_MONITOR_ID)
);
if (ENABLE_CRON) cronJob.start();

async function notifyUptimeKuma(UPTIME_KUMA_URL, UPTIME_KUMA_MONITOR_ID) {
	if (!UPTIME_KUMA_URL || !UPTIME_KUMA_MONITOR_ID) return;
	console.log("Notifying Uptime Kuma");
	axios
		.get(`${UPTIME_KUMA_URL}/api/push/${UPTIME_KUMA_MONITOR_ID}?status=up&msg=OK`)
		// .then((response) => {
		// 	console.log(response.data);
		// });
		.catch((error) => console.error(error.response.data));
}
