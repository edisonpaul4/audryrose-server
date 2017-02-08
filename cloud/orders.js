var _ = require('underscore');
var BigCommerce = require('node-bigcommerce');

var Order = Parse.Object.extend('Order');

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getOrders", function(request, response) {
  var ordersQuery = new Parse.Query(Order);
  ordersQuery.descending("date_created");
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  ordersQuery.find({useMasterKey:true}).then(function(orders) {
	  response.success(orders);
	  
  }, function(error) {
	  response.error("Unable to get orders: " + error.message);
	  
  });
});