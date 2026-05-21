const express = require("express");

const app = express();

app.get("/ping", (req, res) => {
    const host = req.query.host;
    // 仅做字符串响应，不执行任何命令
    res.send(`You requested ping for: ${host}`);
});

app.listen(3000);