#!/usr/bin/env node

const inquirer = require("inquirer");
const mri = require("mri");
const logUpdate = require("log-update");
const chalk = require("chalk");
const hasAnsi = require("has-ansi");
const ora = require("ora");
const moment = require("moment");
const ms = require("ms");
const updateNotifier = require("update-notifier");
const pkg = require("../package.json");
const Client = require("instagram-private-api").V1;

let device, storage;

async function main(_argv) {
  const argv = mri(_argv, {
    string: ["username", "password"],
    boolean: ["version", "help"],
    alias: {
      username: "u",
      password: "p",
      interval: "i",
      version: "v",
      help: "h"
    }
  });
  console.log(chalk.dim(`tg-cli v${pkg.version}`));
  updateNotifier({ pkg }).notify();
  if (argv.version) process.exit(0);
  if (argv.help) {
    console.log(`
Usage:
    $  tg
    $  tg [-h] | [-v] | [-u <username>] [-p <password>] [-i <polling interval>]
    $  tg [--help] | [--version] | [--username=<username>] [--password=<password>] [--interval=<polling interval>]

Options:
    -h, --help                  Show this screen.
    -v, --version               Show version.
    -u, --username <username>   Set Instagram username. [default: will prompt]
    -p, --password <password>   Set Instagram password. [default: will prompt]
    -i, --interval <interval>   Set polling interval (seconds) in chat rooms [default: 5]

Notes:
    In chatroom mode, exit by entering '/end'. Manually refresh the room by entering '/refresh'.
    `);
    process.exit(0);
  }

  if (argv.interval && typeof argv.interval !== "number")
    throw new Error(
      `<interval> argument must be a number. Instead it's a ${typeof argv.interval}`
    );

  let _username;
  if (!argv.username) {
    const { username } = await inquirer.prompt({
      name: "username",
      message: "Instagram Username: "
    });
    _username = username;
  } else {
    _username = argv.username;
  }

  device = new Client.Device(_username);
  storage = new Client.CookieFileStorage(
    __dirname + `/ig-cookie.${_username}.json`
  );

  let _password;
  if (!argv.password) {
    const { password } = await inquirer.prompt({
      name: "password",
      message: "Instagram password: ",
      type: "password"
    });
    _password = password;
  } else {
    _password = argv.password;
  }

  const loginSpinner = ora(`Logging in as ${_username}`).start();

  const session = await Client.Session.create(
    device,
    storage,
    _username,
    _password
  );

  loginSpinner.succeed(`You are logged in as ${_username}`);

  const userAccountId = await storage.getAccountId();

  let mainLoop = true;
  let instagramAccounts = {};

  const parseMessageString = threadItem => {
    const senderId = threadItem._params.userId;
    const senderUsername =
      senderId === userAccountId
        ? chalk.cyan("You")
        : (instagramAccounts[senderId] &&
            chalk.magenta(instagramAccounts[senderId].username)) ||
          chalk.red("A User");

    const payloadType = threadItem._params.itemType;
    let payloadMessage;
    const payloadCreated = threadItem._params.created;
    switch (payloadType) {
      case "text":
        payloadMessage = `"${threadItem._params.text}"`;
        break;
      default:
        payloadMessage = `[a non-text message of type ${payloadType}]`;
        break;
    }
    return `${senderUsername}: ${chalk.white(payloadMessage)} ${chalk.dim(
      `[${moment(payloadCreated).fromNow()}]`
    )}`;
  };

  while (mainLoop) {
    const inboxSpinner = ora("Opening inbox").start();
    const inbox = await new Client.Feed.Inbox(session);
    inboxSpinner.text = "Fetching all threads";
    const inboxAll = await inbox.all();
    inboxSpinner.succeed("All threads have been fetched");

    inboxAll.forEach(m =>
      m.accounts.forEach(a => {
        if (!instagramAccounts[a.id]) {
          instagramAccounts[a.id] = a._params;
        }
      })
    );

    const choices = inboxAll.filter(m => m.accounts.length).map(m => ({
      name: `${chalk.underline(
        `[${m._params.threadTitle}]`
      )} - ${parseMessageString(m.items[0])}`,
      value: m._params.threadId,
      short: m._params.threadTitle
    }));

    const { id } = await inquirer.prompt({
      name: "id",
      message: "Inbox threads: ",
      type: "list",
      choices
    });

    let chatLoop = true;

    while (chatLoop) {
      let thread = await Client.Thread.getById(session, id);
      let threadTitle = `[${thread._params.threadTitle}]`;
      let msgToSend = [];
      const getMsgPayload = () => msgToSend.join("");
      const renderInput = async () => {
        const threadItemsStr = thread.items.length
          ? thread.items
              .sort((a, b) => a._params.created - b._params.created)
              .map(i => parseMessageString(i))
              .join("\n")
          : "There are no messages yet.";
        logUpdate(
          `${threadItemsStr}\n\nReply to ${threadTitle} ${chalk.green(
            "›"
          )} ${getMsgPayload()}`
        );
      };

      const updateThread = async () => {
        thread = await Client.Thread.getById(session, id);
        renderInput();
      };
      const interval = ms(`${argv.interval}s`) || ms("5s");
      const threadRefreshInterval = setInterval(updateThread, interval);

      renderInput();

      await new Promise(resolve => {
        const keypressHandler = async (ch, key = {}) => {
          if (hasAnsi(key.sequence)) return;
          if (key.ctrl && key.name === "c") {
            if (msgToSend.length <= 1) {
              logUpdate();
              // readline.moveCursor(process.stdout, 0, -1);
            }
            process.exit();
          }
          if (key.name === "return" || (key.ctrl && key.name === "u")) {
            const msgPayload = getMsgPayload();
            if (msgToSend.length <= 0) return;
            if (msgPayload === "/end") {
              logUpdate(`[*] Ended chat with ${threadTitle}.`);
              process.stdin.pause();
              process.stdin.removeListener("keypress", keypressHandler);
              chatLoop = false;
              resolve(key);
            } else if (msgPayload === "/refresh") {
              logUpdate("[*] Refreshing");
              process.stdin.pause();
              process.stdin.removeListener("keypress", keypressHandler);
              resolve(key);
            } else {
              await thread.broadcastText(msgPayload);
              msgToSend.length = 0;
              updateThread();
            }
          } else if (key.name === "backspace") {
            msgToSend.pop();
            renderInput();
          } else {
            msgToSend.push(ch);
            renderInput();
          }
        };
        process.stdin.on("keypress", keypressHandler);
        process.stdin.setRawMode(true);
        process.stdin.resume();
      });
      clearInterval(threadRefreshInterval);
    }
  }
}

main(process.argv).catch(err => {
  console.log(err);
  process.exit(1);
});
