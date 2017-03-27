var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var ColorCode = Parse.Object.extend('ColorCode');
var StoneCode = Parse.Object.extend('StoneCode');

// CONFIG
bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");
// Set up Bigcommerce API
var bigCommerce = new BigCommerce({
  logLevel: 'errors',
  clientId: process.env.BC_CLIENT_ID,
  secret: process.env.BC_CLIENT_SECRET,
  callback: 'https://audryrose.herokuapp.com/auth',
  responseType: 'json'
});
bigCommerce.config.accessToken = process.env.BC_ACCESS_TOKEN;
bigCommerce.config.storeHash = process.env.BC_STORE_HASH;
const BIGCOMMERCE_BATCH_SIZE = 250;

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getOptions", function(request, response) {
  var totalOptions;
  var subpage = request.params.subpage ? request.params.subpage : 'colors';
  
  var optionsQuery;
  switch (subpage) {
    case 'colors':
      optionsQuery = new Parse.Query(ColorCode);
      break;
    case 'stones':
      optionsQuery = new Parse.Query(StoneCode);
      break;
    default:
      optionsQuery = new Parse.Query(ColorCode);
      break;
  }
  optionsQuery.ascending('option_value_id');
  optionsQuery.limit(10000);
  
  optionsQuery.count().then(function(count) {
    totalOptions = count;
    return optionsQuery.find({useMasterKey:true});
    
  }).then(function(options) {
	  response.success({options: options});
	  
  }, function(error) {
	  logError(error);
	  response.error(error);
	  
  });
});

Parse.Cloud.define("saveOption", function(request, response) {
  var objectId = request.params.objectId;
  var manualCode = request.params.manualCode;
  var optionToUpdate;
  
  var colorQuery = new Parse.Query(ColorCode);
  colorQuery.equalTo('objectId', objectId);
  colorQuery.first().then(function(option) {
    if (option) optionToUpdate = option;
    
    var stoneQuery = new Parse.Query(StoneCode);
    stoneQuery.equalTo('objectId', objectId);
    return stoneQuery.first();
    
  }).then(function(option) {
    if (option) optionToUpdate = option;
    
    if (manualCode && manualCode != '') {
      optionToUpdate.set('manualCode', manualCode);
    } else {
      optionToUpdate.unset('manualCode');
    }
    return optionToUpdate.save(null, {useMasterKey: true});
    
  }).then(function(optionObject) {
	  response.success(optionObject);
    
  }, function(error) {
		logError(error);
		response.error(error);
		
	});
  
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var logInfo = function(i) {
  console.info(i);
}

var logError = function(e) {
  var msg = e && e.text ? e.text : JSON.stringify(e);
  console.error(msg);
	bugsnag.notify(msg);
}