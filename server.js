const express = require('express');
const AWS = require('aws-sdk');
const bodyParser = require('body-parser');
const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { DynamoDBDocumentClient, QueryCommand, ScanCommand  } = require('@aws-sdk/lib-dynamodb');
const session = require('express-session');
const path = require('path');

const WebSocket = require('ws');
const http = require('http');
// //const mysql = require('mysql');
// //const mysql = require('mysql');
const mysql = require('mysql2');// use mysql2 instead of mysql


const app = express();


const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const dbClient = new DynamoDBClient({
    region: 'us-east-1', // 你的 DynamoDB 区域
    credentials: {
        accessKeyId: 'XXXXXXXXXXX',    //替换
        secretAccessKey: 'XXXXXXXXXXX'    //替换
    }
});


// 配置 AWS Cognito 参数
const cognito = new AWS.CognitoIdentityServiceProvider({
    region: 'us-east-1' // 设置为你Cognito User Pool所在的区域
});

//const app = express();
app.use(bodyParser.json());


// 设置 session 中间件
app.use(session({
    secret: 'your-secret-key', // 用于加密 session 的密钥
    resave: false, // 如果 session 没有变化则不保存
    saveUninitialized: true, // 对所有请求都设置 session，即使没有初始化
    cookie: { secure: false } // 开发环境下设置为 false, 生产环境下使用 HTTPS 时应为 true
}));

const USER_POOL_ID = 'us-east-1_KWQe9X3Pp'; // 替换为你的 User Pool ID
const CLIENT_ID = '3jgvd3uni2chn30us56m4fleem'; // 替换为你的 Client ID

app.use(express.static('public'));

// 注册新用户
app.post('/register', (req, res) => {
    const { email, password, givenName, familyName } = req.body;

    const params = {
        ClientId: CLIENT_ID,
        Username: email,
        Password: password,
        UserAttributes: [
            {
                Name: 'email',
                Value: email
            },
            {
                Name: 'given_name',
                Value: givenName
            },
            {
                Name: 'family_name',
                Value: familyName
            }
        ]
    };

    cognito.signUp(params, (err, data) => {
        if (err) {
            console.error('Error registering user:', err);
            return res.status(400).send(err.message || JSON.stringify(err));
        }
        res.json({
            message: 'User registered successfully!',
            data: data
        });
    });
});


// 确认用户注册（用户需要输入通过电子邮件收到的验证码）
app.post('/confirm', (req, res) => {
    const { email, code } = req.body;

    const params = {
        ClientId: CLIENT_ID,
        Username: email, // 使用 email 作为用户名
        ConfirmationCode: code
    };

    cognito.confirmSignUp(params, (err, data) => {
        if (err) {
            console.error('Error confirming user:', err);
            return res.status(400).send(err.message || JSON.stringify(err));
        }
        res.json({
            message: 'User confirmed successfully!',
            data: data
        });
    });
});

// 登录
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    const params = {
        AuthFlow: 'USER_PASSWORD_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
            USERNAME: email, // 使用 email 作为用户名
            PASSWORD: password
        }
    };

    cognito.initiateAuth(params, (err, data) => {
        if (err) {
            console.error('Error logging in:', err);
            return res.status(400).send(err.message || JSON.stringify(err));
        }
//console.log("data",data)
        req.session.user = {
            email: email,
            token: data.AuthenticationResult.AccessToken // 你可以根据需要保存更多信息
        };

        // 登录成功后重定向到 ship.html
        //res.redirect('/ship');
        res.json({ redirectUrl: '/ship' });

    });
});


// 路由处理：重定向到 ship.html
app.get('/ship', (req, res) => {
    //console.error('User:&&&&', req);
    // if (!req.session.user) {
    //     //console.error('%%%%%%');

    //     return res.status(401).send('Unauthorized: You need to login first.');
    // }
    // 返回 ship.html 文件
    res.sendFile(path.join(__dirname, 'public', 'ship.html'), (err) => {
        //console.error('Error sending file:*******', err);
        if (err) {
            console.error('Error sending file:', err);
            return res.status(500).send('Internal Server Error');
        }
    });
});
// // 检查 session 的路由
app.get('/check-session', (req, res) => {
    if (req.session.user) {
        // 如果 session 存在，返回 200 状态码
        res.status(200).send('Session exists');
    } else {
        // 如果没有 session，返回 401 未授权
        res.status(401).send('No session');
    }
});


// 启动服务器
// app.listen(3000, () => {
//     console.log('Server is running on port 3000');
// });







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

// 根据 MMSI 搜索船只
app.get('/search', (req, res) => {
    // 验证用户是否已登录
    if (!req.session.user || !req.session.user.email) {
        return res.status(403).json({ error: 'Unauthorized access' }); // 如果未登录，返回 403 错误
    }

    const mmsi = req.query.mmsi;

    if (!mmsi) {
        return res.status(400).send({ error: 'MMSI is required' });
    }

    // 可以通过 req.session.user 获取到当前登录用户的信息，比如 userId
    const userEmail = req.session.user.email;
    //console.log("userId",userEmail)

    // 构建 DynamoDB 数据项
    const item = {
        TableName: "UserSearches", // 你的 DynamoDB 表名
        Item: {
            "Email": { S: userEmail },
            "MMSI": { S: mmsi },
            "SearchTime": { S: new Date().toISOString() } // 存储搜索时间
        }
    };

    try {
        // 将用户搜索存储到 DynamoDB
        dbClient.send(new PutItemCommand(item));
        console.log("Search stored successfully in DynamoDB.");
    } catch (error) {
        console.error("Error storing search in DynamoDB:", error);
        return res.status(500).send({ error: 'Failed to store search data' });
    }

    // 更新查询以加入用户限制，确保用户只能搜索到与他们相关的船只信息
    const query = `
        SELECT MMSI, Latitude, Longitude, Cog, CommunicationState, NavigationalStatus, 
               PositionAccuracy, Raim, RateOfTurn, Sog, Timestamp, TrueHeading, ShipName, time_utc
        FROM ship
        WHERE MMSI = ?
        LIMIT 1
    `;

    // 传入 MMSI 和 UserId 作为查询参数
    db.query(query, [mmsi], (err, results) => {
        if (err) {
            console.error('Error searching ship from database:', err.stack);
            return res.status(500).send({ error: 'Database query failed' });
        }

        if (results.length > 0) {
            res.send(results[0]);
        } else {
            res.status(404).send({ error: 'Ship not found' });
        }
    });
});


// 按照 ShipName 搜索船只
app.get('/searchByName', (req, res) => {

    // 验证用户是否已登录
    if (!req.session.user || !req.session.user.email) {
        return res.status(403).json({ error: 'Unauthorized access' }); // 如果未登录，返回 403 错误
    }

    const shipName = req.query.shipName;

    if (!shipName) {
        return res.status(400).send({ error: 'ShipName is required' });
    }

    const userEmail = req.session.user.email;
    //console.log("userId",userEmail)

    // 构建 DynamoDB 数据项
    const item = {
        TableName: "UserSearches", // 你的 DynamoDB 表名
        Item: {
            "Email": { S: userEmail },
            "shipName": { S: shipName },
            "SearchTime": { S: new Date().toISOString() } // 存储搜索时间
        }
    };

    try {
        // 将用户搜索存储到 DynamoDB
        dbClient.send(new PutItemCommand(item));
        console.log("Search stored successfully in DynamoDB.");
    } catch (error) {
        console.error("Error storing search in DynamoDB:", error);
        return res.status(500).send({ error: 'Failed to store search data' });
    }
    const query = `
        SELECT MMSI, Latitude, Longitude, Cog, CommunicationState, NavigationalStatus, 
               PositionAccuracy, Raim, RateOfTurn, Sog, Timestamp, TrueHeading, ShipName, time_utc
        FROM ship
        WHERE ShipName LIKE ?
        LIMIT 10
    `;

    db.query(query, [`%${shipName}%`], (err, results) => {
        if (err) {
            console.error('Error searching ship from database:', err.stack);
            return res.status(500).send({ error: 'Database query failed' });
        }

        if (results.length > 0) {
            res.send(results);
        } else {
            res.status(404).send({ error: 'No ships found' });
        }
    });
});

const docClient = DynamoDBDocumentClient.from(dbClient);
app.get('/searchHistory', async (req, res) => {
    if (!req.session.user || !req.session.user.email) {
        return res.status(403).json({ error: 'Unauthorized access' });
    }

    const userEmail = req.session.user.email;
    const params = {
        TableName: "UserSearches",
        FilterExpression: "Email = :email",
        ExpressionAttributeValues: {
            ":email": userEmail
        }
    };

    try {
        // 创建并发送 ScanCommand
        const command = new ScanCommand(params);
        const { Items } = await docClient.send(command);
        res.json(Items || []);
    } catch (error) {
        console.error('Error querying DynamoDB:', error);
        res.status(500).send({ error: 'Failed to retrieve data' });
    }
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

        // 构建查询语句，限制查询结果为 200 条
        const query = `
            SELECT MMSI, Latitude, Longitude, Cog, CommunicationState, NavigationalStatus, 
                   PositionAccuracy, Raim, RateOfTurn, Sog, Timestamp, TrueHeading, ShipName, time_utc
            FROM ship
            WHERE Longitude BETWEEN ? AND ? AND Latitude BETWEEN ? AND ?
            ORDER BY time_utc DESC
            LIMIT 50
        `;

        // 执行查询
        db.query(query, [bounds.west, bounds.east, bounds.south, bounds.north], (err, results) => {
            if (err) {
                console.error('Error querying ships from database:', err.stack);
                ws.send(JSON.stringify({ error: 'Database query failed' }));
                return;
            }

            // 向前端发送查询结果
            ws.send(JSON.stringify(results));
        });
    });

    ws.on('close', function () {
        console.log('Browser disconnected');
    });
});

// 在拖动地图时停止向客户端发送数据
function stopSendingData(ws) {
    ws.sendingData = false;
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is listening on port ${PORT}`);
});
