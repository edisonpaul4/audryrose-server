var _ = require('underscore');
var BigCommerce = require('node-bigcommerce');

var Order = Parse.Object.extend('Order');

const PRODUCTS_PER_PAGE = 50;

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getOrders", function(request, response) {
  var totalOrders;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  
  var ordersQuery = new Parse.Query(Order);
  ordersQuery.descending("date_created");
  ordersQuery.limit(PRODUCTS_PER_PAGE);
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  ordersQuery.count().then(function(count) {
    totalOrders = count;
    totalPages = Math.ceil(totalOrders / PRODUCTS_PER_PAGE);
    ordersQuery.skip((currentPage - 1) * PRODUCTS_PER_PAGE);
    return ordersQuery.find({useMasterKey:true});
    
  }).then(function(orders) {
	  response.success({orders: orders, totalPages: totalPages});
	  
  }, function(error) {
	  response.error("Unable to get orders: " + error.message);
	  
  });
});