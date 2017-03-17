var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');

var Product = Parse.Object.extend('Product');
var Order = Parse.Object.extend('Order');
var OrderShipment = Parse.Object.extend('OrderShipment');

// CONFIG
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
const SHIPMENTS_PER_PAGE = 50;

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getShipments", function(request, response) {
  var totalShipments;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'name-asc';
  
  var shipmentsQuery = new Parse.Query(OrderShipment);
  shipmentsQuery = getShipmentSort(shipmentsQuery, currentSort)
  shipmentsQuery.limit(SHIPMENTS_PER_PAGE);
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  shipmentsQuery.count().then(function(count) {
    totalShipments = count;
    totalPages = Math.ceil(totalShipments / SHIPMENTS_PER_PAGE);
    shipmentsQuery.skip((currentPage - 1) * SHIPMENTS_PER_PAGE);
    return shipmentsQuery.find({useMasterKey:true});
    
  }).then(function(shipments) {
	  response.success({shipments: shipments, totalPages: totalPages});
	  
  }, function(error) {
	  console.error("Unable to get shipments: " + error.message);
	  response.error("Unable to get shipments: " + error.message);
	  
  });
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var getShipmentSort = function(shipmentsQuery, currentSort) {
  switch (currentSort) {
    case 'date-added-desc':
      shipmentsQuery.descending("date_created");
      break;
    case 'date-added-asc':
      shipmentsQuery.ascending("date_created");
      break;
    default:
      shipmentsQuery.descending("date_created");
      break;
  }
  return shipmentsQuery;
}