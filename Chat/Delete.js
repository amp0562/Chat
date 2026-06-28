const sqlite3 = require("sqlite3").verbose();

const db = new sqlite3.Database("./chat.db", (err) => {
  if (err) {
    console.error(err.message);
  } else {
    console.log("Connected to the SQLite database.");
  }
});

db.serialize(() => {
  db.run("DELETE FROM users", function (err) {
    if (err) {
      console.error(err.message);
      return;
    }

    console.log(`Deleted ${this.changes} users`);
  });
});

db.close((err) => {
  if (err) {
    console.error(err.message);
  } else {
    console.log("Closed DB");
  }
});