var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');

var ColorCode = Parse.Object.extend('ColorCode');
var StoneCode = Parse.Object.extend('StoneCode');

// CONFIG
// Set up Bigcommerce API
var bigCommerce = new BigCommerce({
  logLevel: 'error',
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
	  console.error("Unable to get options: " + error.message);
	  response.error("Unable to get options: " + error.message);
	  
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
		console.error("Error saving option: " + error.message);
		response.error("Error saving option: " + error.message);
		
	});
  
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////