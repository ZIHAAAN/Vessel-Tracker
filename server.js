const express = require('express');
const WebSocket = require('ws');
const http = require('http');
const mysql = require('mysql');
//const mysql = require('mysql2');// use mysql2 instead of mysql
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// 使用 Map 存储船只数据，MMSI 作为键
const allShips = new Map();

// 配置 MySQL 连接
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: '123456',
    database: 'map'
});

db.connect(err => {
    if (err) {
        console.error('Error connecting to MySQL:', err.stack);
        return;
    }
    console.log('Connected to MySQL as id ' + db.threadId);

    // 创建 ship 表，如果不存在
    const createTableQuery = `
        CREATE TABLE IF NOT EXISTS ship (
            MMSI BIGINT PRIMARY KEY,
            Latitude DOUBLE,
            Longitude DOUBLE,
            Cog DOUBLE,
            CommunicationState INT,
            NavigationalStatus INT,
            PositionAccuracy BOOLEAN,
            Raim BOOLEAN,
            RateOfTurn DOUBLE,
            Sog DOUBLE,
            Timestamp INT,
            TrueHeading INT,
            ShipName VARCHAR(255),
            time_utc DATETIME
        )
    `;
    db.query(createTableQuery, (err, result) => {
        if (err) {
            console.error('Error creating ship table:', err.stack);
        } else {
            console.log('Ship table is ready.');
        }
    });
});

// 创建一个缓存数组用于存储待插入的船只数据
const shipDataBuffer = [];

// 连接到 aisstream.io WebSocket
const aisSocket = new WebSocket('wss://stream.aisstream.io/v0/stream');

aisSocket.on('open', function open() {
    console.log('Connected to aisstream.io');

    const subscriptionMessage = {
        Apikey: '431a0cfa3a12578db359c614a01d4551dbf77f9a',
        BoundingBoxes: [[[-90, -180], [90, 180]]],
        FilterMessageTypes: ["PositionReport"]
    };

    aisSocket.send(JSON.stringify(subscriptionMessage));
});

aisSocket.on('message', function incoming(data) {
    const aisMessage = JSON.parse(data);
    const mmsi = aisMessage.MetaData.MMSI;

    // 更新或添加船只数据
    allShips.set(mmsi, aisMessage);

    const { PositionReport } = aisMessage.Message;
    const { MetaData } = aisMessage;
    const timeUtc = new Date(MetaData.time_utc).toISOString().slice(0, 19).replace('T', ' ');

    // 将数据推入缓存数组
    shipDataBuffer.push([
        mmsi,
        MetaData.latitude,
        MetaData.longitude,
        PositionReport.Cog,
        PositionReport.CommunicationState,
        PositionReport.NavigationalStatus,
        PositionReport.PositionAccuracy,
        PositionReport.Raim,
        PositionReport.RateOfTurn,
        PositionReport.Sog,
        PositionReport.Timestamp,
        PositionReport.TrueHeading,
        MetaData.ShipName,
        timeUtc
    ]);

    // 如果缓存数组达到批量大小，则立即插入数据库
    if (shipDataBuffer.length >= 1000) {
        console.log("Buffer full, performing batch insert.");

        const insertQuery = `
            INSERT INTO ship (MMSI, Latitude, Longitude, Cog, CommunicationState, NavigationalStatus, PositionAccuracy, Raim, RateOfTurn, Sog, Timestamp, TrueHeading, ShipName, time_utc)
            VALUES ?
            ON DUPLICATE KEY UPDATE
            Latitude = VALUES(Latitude),
            Longitude = VALUES(Longitude),
            Cog = VALUES(Cog),
            CommunicationState = VALUES(CommunicationState),
            NavigationalStatus = VALUES(NavigationalStatus),
            PositionAccuracy = VALUES(PositionAccuracy),
            Raim = VALUES(Raim),
            RateOfTurn = VALUES(RateOfTurn),
            Sog = VALUES(Sog),
            Timestamp = VALUES(Timestamp),
            TrueHeading = VALUES(TrueHeading),
            ShipName = VALUES(ShipName),
            time_utc = VALUES(time_utc)
        `;

        db.query(insertQuery, [shipDataBuffer], (err, result) => {
            if (err) {
                console.error('Error in batch insert:', err.stack);
            } else {
                console.log(`Batch insert successful, inserted/updated ${result.affectedRows} rows.`);
            }
        });

        // 清空缓存数组
        shipDataBuffer.length = 0;
    }

    // 遍历所有连接的客户端，筛选符合客户端范围的船只数据并发送
    wss.clients.forEach(function each(client) {
        if (client.readyState === WebSocket.OPEN && client.bounds) {
            const shipsInBounds = filterShipsByBounds(Array.from(allShips.values()), client.bounds);
            client.send(JSON.stringify(shipsInBounds));
        }
    });
});

// 过滤船只数据，只返回在指定范围内的船只
function filterShipsByBounds(ships, bounds) {
    return ships.filter(ship => {
        const latitude = ship.MetaData.latitude;
        const longitude = ship.MetaData.longitude;
        return longitude >= bounds.west && longitude <= bounds.east &&
            latitude >= bounds.south && latitude <= bounds.north;
    });
}

// 处理 WebSocket 错误
aisSocket.on('error', function error(err) {
    console.error('WebSocket error:', err);
});

// 提供前端静态文件
app.use(express.static('public'));

// 处理来自浏览器的 WebSocket 连接
wss.on('connection', function connection(ws) {
    console.log('Browser connected to WebSocket server');

    ws.on('message', function incoming(message) {
        const bounds = JSON.parse(message);
        ws.bounds = bounds;

        const shipsInBounds = filterShipsByBounds(Array.from(allShips.values()), bounds);
        ws.send(JSON.stringify(shipsInBounds));
    });

    ws.on('close', function () {
        console.log('Browser disconnected');
    });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});