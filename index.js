var express = require('express');
var ParseServer = require('parse-server').ParseServer;
var ParseDashboard = require('parse-dashboard');
var path = require('path');
var exphbs = require('express-handlebars');
var helpers = require('handlebars-helpers')();
var bodyParser = require('body-parser');
var dotenv = require('dotenv').config({silent: true});

var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;
var allowInsecureHTTP = true; // Change to false in production

if (!databaseUri) {
  console.log('DATABASE_URI not specified, falling back to localhost.');
}

var api = new ParseServer({
  databaseURI: databaseUri || 'mongodb://localhost:27017/dev',
  cloud: __dirname + process.env.CLOUD_CODE_MAIN || __dirname + '/cloud/main.js',
  appId: process.env.APP_ID || 'app',
  masterKey: process.env.MASTER_KEY || '',
  serverURL: process.env.SERVER_URL || 'http://localhost:1337/parse',
//   liveQuery: { classNames: ["Posts", "Comments"] }
});

var dashboard = new ParseDashboard({
  "apps": [
    {
      "serverURL": process.env.SERVER_URL || 'http://localhost:1337/parse',
      "appId": process.env.APP_ID || 'app',
      "masterKey": process.env.MASTER_KEY || '',
      "appName": "Audry Rose IMS"
    },
  ],
  "users": [
    {
      "user":"jeremy",
      "pass":"asdfasdf"
    }
  ],
  "useEncryptedPasswords": false
}, allowInsecureHTTP);

// Set up the app
var app = express();
app.use(express.static(path.join(__dirname, '/public')));
app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json());
var mountPath = process.env.PARSE_MOUNT || '/parse';
app.use(mountPath, api);
app.use('/dashboard', dashboard);

// Routes
app.get('/', function (req, res) {
  res.render('home');
});

var port = process.env.PORT || 1337;
var httpServer = require('http').createServer(app);
httpServer.listen(port, function() {
  console.log('reflectr server running on port ' + port + '.');
});

// This will enable the Live Query real-time server
ParseServer.createLiveQueryServer(httpServer);
