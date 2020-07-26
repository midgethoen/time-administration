const request = require("request-promise");
const Promise = require("bluebird");
const R = require("ramda");
const qs = require("query-string");
const cli = require("cli");

const opts = cli.parse({
  month: ["m", "Relative month ( 0=current, 1=previous)", "int", 1],
  dry: ["d", "Dry-run-mode: outputs modifications and stops", "bool", false],
});
const API_TOKEN = process.env.API_TOKEN;
if (!API_TOKEN) {
  throw new Error("API_TOKEN is required");
}

const config = require("./config.json");
const { maxBreakRatio, tags } = config;
const isConfiguredClient = (c) => R.contains(c.name, config.clients);

const apiUrl = "https://www.toggl.com/api/v8";
const options = {
  json: true,
  auth: {
    user: API_TOKEN,
    pass: "api_token",
    sendImmediately: true,
  },
};

const month = 0; // 0 is current

function describe(e) {
  return `${e.start} - ${e.stop} (${(e.duration / 3600).toPrecision(2)}h)[${(
    e.tags || []
  ).join(",")}]`;
}

function getDay(ts) {
  const date = new Date(ts);
  date.setHours(0);
  date.setMinutes(0);
  date.setSeconds(0);
  date.setMilliseconds(0);
  return date.getTime();
}

function addToDate(ts, seconds) {
  const d = new Date(ts);
  d.setTime(d.getTime() + seconds * 1e3);
  return d;
}

const isNonBillable = (e) =>
  e.tags && (e.tags.includes(tags.traveling) || e.tags.includes(tags.break));

const summarize = (filterFunc, entries) =>
  R.pipe(R.filter(filterFunc), R.pluck("duration"), R.sum)(entries);

async function main() {
  const me = await authenticate();
  const workspaceId = me.data.workspaces[0].id;

  // get clients to process
  let clients = await request.get(`${apiUrl}/clients`, options);
  clients = clients.filter(isConfiguredClient);

  // get projects
  let projects = await request.get(
    `${apiUrl}/workspaces/${workspaceId}/projects`,
    options
  );
  const isClientId = R.contains(
    R.__,
    clients.map((c) => c.id)
  );
  const projectFilter = (p) => isClientId(p.cid);
  projects = projects.filter(projectFilter);

  // get entries for the given month
  const date = new Date();
  const start_date = new Date(
    date.getFullYear(),
    date.getMonth() - opts.month,
    1
  );
  const end_date = new Date(
    date.getFullYear(),
    date.getMonth() - opts.month + 1,
    1
  );
  const urlParams = qs.stringify({
    start_date: start_date.toISOString(),
    end_date: end_date.toISOString(),
  });
  // console.log(`${apiUrl}/time_entries?${urlParams}`)
  let entries = await request.get(
    `${apiUrl}/time_entries?${urlParams}`,
    options
  );
  const isProjectId = R.contains(
    R.__,
    projects.map((c) => c.id)
  );
  const entrieFilter = (e) => isProjectId(e.pid);
  filteredEntries = entries.filter(entrieFilter);

  // process entries per day
  results = R.pipe(
    R.groupBy((e) => getDay(e.start)),
    R.toPairs,
    R.sortBy(R.prop(0)),
    R.map(([k, entries]) => {
      const date = new Date(parseInt(k));
      const billable = summarize(R.complement(isNonBillable), entries);
      const nonBillable = summarize(isNonBillable, entries);

      // log the break ratio
      // const breakl = summarize(e => e.tags && e.tags.includes(tags.break) && e.billable, entries)
      // console.log(date, billable / breakl);

      const maxbreakLength = Math.floor(billable / maxBreakRatio);
      let breakLength = 0;
      const modifications = [];
      const modify = (e, patch) => ({
        type: "modify",
        desc: describe(e),
        id: e.id,
        patch,
      });
      const insert = (e, patch) => ({
        type: "insert",
        desc: describe(e),
        time_entry: {
          ...R.pick(
            ["wid", "pid", "uid", "billable", "description", "tags"],
            e
          ),
          created_with: "administrative script",
          ...patch,
        },
      });
      entries.forEach((e) => {
        // billable = billable
        if (!isNonBillable(e) && !e.billable) {
          modifications.push(modify(e, { billable: true }));
        }
        // traveling is not billable
        if (e.tags && e.tags.includes(tags.traveling) && e.billable) {
          modifications.push(modify(e, { billable: false }));
        }
        // breaks are billable until maxbreakLength
        if (e.tags && e.tags.includes(tags.break)) {
          if (breakLength >= maxbreakLength && e.billable) {
            // is completely unbillable
            modifications.push(modify(e, { billable: false }));
          } else if (
            breakLength < maxbreakLength &&
            breakLength + e.duration > maxbreakLength
          ) {
            // is partially unbillable -> split
            const billableDuration = maxbreakLength - breakLength;
            modifications.push(
              modify(e, { duration: billableDuration, billable: true })
            );
            modifications.push(
              insert(e, {
                start: addToDate(e.start, billableDuration).toISOString(),
                duration: e.duration - billableDuration,
                billable: false,
              })
            );
          } else if (
            breakLength + e.duration <= maxbreakLength &&
            !e.billable
          ) {
            // billable
            modifications.push(modify(e, { billable: true }));
          }
          breakLength += e.duration;
        }
      });

      return {
        entries,
        date,
        billable,
        nonBillable,
        modifications,
      };
    })
  )(filteredEntries);

  const mods = R.unnest(R.pluck("modifications", results));
  console.log(`created ${mods.length} mods`);
  if (opts.dry) {
    console.log(JSON.stringify(mods, null, 2));
  } else {
    Promise.map(
      mods,
      (mod) => {
        if (mod.type === "insert") {
          return request.post(`${apiUrl}/time_entries`, {
            ...options,
            body: { time_entry: mod.time_entry },
          });
        } else if (mod.type === "modify") {
          return request.put(`${apiUrl}/time_entries/${mod.id}`, {
            ...options,
            body: { time_entry: mod.patch },
          });
        }
      },
      { concurrency: 1 }
    );
  }
}

async function authenticate() {
  const stdout = process.stdout;
  stdout.write("Authenticating...  ");
  const response = await request.get(`${apiUrl}/me`, {
    ...options,
    resolveWithFullResponse: true,
  });
  if (response.statusCode !== 200) {
    console.log("✗");
    throw new Error("Could not authenticate");
  }
  console.log("✓");

  return response.body;
}

main();

process.on("unhandledRejection", (err) => {
  console.error(err.message);
  process.exit(1);
});
