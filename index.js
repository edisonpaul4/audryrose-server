if (process.env.NODE_ENV == 'production') require('newrelic');
var express = require('express');
var ParseServer = require('parse-server').ParseServer;
var S3Adapter = require('parse-server').S3Adapter;
var ParseDashboard = require('parse-dashboard');
var path = require('path');
var exphbs = require('express-handlebars');
var helpers = require('handlebars-helpers')();
var bodyParser = require('body-parser');
var compression = require('compression');
var dotenv = require('dotenv').config({silent: true});
var bugsnag = require("bugsnag");
// var memwatch = require('memwatch-next');

var databaseUri = process.env.DATABASE_URI || process.env.MONGODB_URI;
var allowInsecureHTTP = true; // Change to false in production

bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");

if (!databaseUri) {
  console.log('DATABASE_URI not specified, falling back to localhost.');
}

var api = new ParseServer({
  databaseURI: databaseUri || 'mongodb://localhost:27017/dev',
  cloud: __dirname + process.env.CLOUD_CODE_MAIN || __dirname + '/cloud/main.js',
  appId: process.env.APP_ID || 'app',
  masterKey: process.env.MASTER_KEY || '',
  serverURL: process.env.SERVER_URL || 'http://localhost:1337/parse',
  verbose: false,
  loggerAdapter: {
    module: "parse-server/lib/Adapters/Logger/WinstonLoggerAdapter",
    options: {
      logLevel: 'error'
    }
  },
  filesAdapter: new S3Adapter(
    process.env.S3_ACCESS_KEY,
    process.env.S3_SECRET_KEY,
    process.env.S3_BUCKET,
    { directAccess: true }
  )
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
      "user":process.env.DASHBOARD_USER,
      "pass":process.env.DASHBOARD_PASSWORD
    }
  ],
  "useEncryptedPasswords": false
}, allowInsecureHTTP);

// Set up the app
var app = express();
app.use(compression());
app.use(express.static(path.join(__dirname, '/public')));
app.engine('handlebars', exphbs({defaultLayout: 'main'}));
app.set('view engine', 'handlebars');
app.use(bodyParser.urlencoded({ extended: false }))
app.use(bodyParser.json());
var mountPath = process.env.PARSE_MOUNT || '/parse';
app.use(mountPath, api);
app.use('/dashboard', dashboard);
app.use(bugsnag.requestHandler);
app.use(bugsnag.errorHandler);

// Routes
app.get('/', function (req, res) {
  res.render('home');
});

var port = process.env.PORT || 1337;
var httpServer = require('http').createServer(app);
httpServer.listen(port, function() {
  console.log('Audry Rose server running on port ' + port + '.');
});

/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var logInfo = function(i) {
  console.info(i);
}

var logError = function(e) {
  var msg = JSON.stringify(e);
  console.error(msg);
	if (process.env.NODE_ENV == 'production') bugsnag.notify(msg);
}