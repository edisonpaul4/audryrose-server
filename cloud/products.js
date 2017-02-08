var _ = require('underscore');
var BigCommerce = require('node-bigcommerce');

var Product = Parse.Object.extend('Product');

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getProducts", function(request, response) {
  var productsQuery = new Parse.Query(Product);
  productsQuery.descending("date_created");
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  productsQuery.find({useMasterKey:true}).then(function(products) {
	  response.success(products);
	  
  }, function(error) {
	  response.error("Unable to get products: " + error.message);
	  
  });
});