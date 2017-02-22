var _ = require('underscore');
var moment = require('moment');
var request = require('request');
var cheerio = require('cheerio');
var BigCommerce = require('node-bigcommerce');

var Product = Parse.Object.extend('Product');
var Order = Parse.Object.extend('Order');

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
//  BACKGROUND JOBS    //
/////////////////////////

Parse.Cloud.job("test", function(request, status) {
  bigCommerce.get('/store', function(err, data, response){
    console.log(JSON.stringify(data));
    var message = "Successfully connected to " + data.name + ". The store id is " + data.id + ".";
    console.log(message);
    status.success(message);
  }, function(error) {
  	console.log(JSON.stringify(error));
		status.error(error.message);
  });
	
});

Parse.Cloud.job("updateProducts", function(request, status) {
  var totalProducts = 0;
  var totalProductsAdded = 0;
  var products = [];
  
  var startTime = moment();
  
  bigCommerce.get('/products/count', function(err, data, response){
    totalProducts = data.count;
    return data.count;
    
  }).then(function(count) {
    
    var numBatches = Math.ceil(totalProducts / BIGCOMMERCE_BATCH_SIZE);
    console.log('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(10).then(function() {
          var request = '/products?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE;
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(product) {
    				products.push(product);
          });
          return true;
        }, function(error) {
          console.log(error.message);
        });
      });
    });
    return promise;
    
  }).then(function() {
    console.log('Number of products to search: ' + products.length);
    var promise = Parse.Promise.as();
    //products = products.slice(0,1);// REMOVE
		_.each(products, function(product) {
  		console.log('process product id: ' + product.id);
  		promise = promise.then(function() {
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadProduct',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            product: product
          }
        });
    		
  		}).then(function(response) {
    		if (response.data.result.added) totalProductsAdded++;
        return response;
        
      }, function(error) {
    		return "Error creating product: " + error.message;
  			
  		});
    });		
		return promise;

    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalProducts + ' products in Bigcommerce. ';
    message += products.length + ' products loaded. ';
    message += totalProductsAdded + ' products added. ';
    message += 'Job time: ' + jobTime;
    console.log(message);
    status.success(message);
  }, function(error) {
  	console.log(JSON.stringify(error));
		status.error(error.message);
  });
});

Parse.Cloud.job("updateProductVariants", function(request, status) {
  var totalProducts = 0;
  var totalProductsProcessed = 0;
  var totalVariantsAdded = 0;
  var products = [];
  
  var startTime = moment();
  
  var productsQuery = new Parse.Query(Product);
  productsQuery.doesNotExist('variants');
  productsQuery.limit(100);
  
  productsQuery.count().then(function(count) {
    totalProducts = count;
    console.log("Total products: " + totalProducts);
    return productsQuery.find({useMasterKey:true});
    
  }).then(function(products) {
    console.log('Number of products to get variants: ' + products.length);
    var promise = Parse.Promise.as();
		_.each(products, function(product) {
  		console.log('process product id: ' + product.get('productId'));
  		promise = promise.then(function() {
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadProductVariants',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            productId: product.get('productId')
          }
        });
    		
  		}).then(function(response) {
    		totalProductsProcessed++;
    		totalVariantsAdded += response.data.result;
        return totalVariantsAdded;
        
      }, function(error) {
    		return "Error creating variants: " + error.message;
  			
  		});
    });		
		return promise;
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalProducts + ' products needing variants. ';
    message += totalProductsProcessed + ' products processed. ';
    message += totalVariantsAdded + ' variants added. ';
    message += 'Job time: ' + jobTime;
    console.log(message);
    status.success(message);
    
  }, function(error) {
	  status.error(error.message);
  });
  
});

Parse.Cloud.job("updateCategories", function(request, status) {
  var totalCategories = 0;
  var totalCategoriesAdded = 0;
  var categories = [];
  
  var startTime = moment();
  
  bigCommerce.get('/categories/count', function(err, data, response){
    totalCategories = data.count;
    return data.count;
    
  }).then(function(count) {
    
    var numBatches = Math.ceil(totalCategories / BIGCOMMERCE_BATCH_SIZE);
    console.log('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(10).then(function() {
          var request = '/categories?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE;
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(category) {
    				categories.push(category);
          });
          return true;
        }, function(error) {
          console.log(error.message);
        });
      });
    });
    return promise;
    
  }).then(function() {
    console.log('Number of categories to search: ' + categories.length);
    var promise = Parse.Promise.as();
		_.each(categories, function(category) {
  		console.log('process category id: ' + category.id);
  		promise = promise.then(function() {
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadCategory',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            category: category
          }
        });
    		
  		}).then(function(response) {
    		if (response.data.result.added) totalCategoriesAdded++;
        return response;
        
      }, function(error) {
    		return "Error creating categories: " + error.message;
  			
  		});
    });		
		return promise;

    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalCategories + ' categories in Bigcommerce. ';
    message += categories.length + ' categories loaded. ';
    message += totalCategoriesAdded + ' categories added. ';
    message += 'Job time: ' + jobTime;
    console.log(message);
    status.success(message);
  }, function(error) {
  	console.log(JSON.stringify(error));
		status.error(error.message);
  });
});

Parse.Cloud.job("updateOrders", function(request, status) {
  var totalOrders = 0;
  var totalOrdersAdded = 0;
  var orders = [];
  
  var startTime = moment();
  
  bigCommerce.get('/orders/count', function(err, data, response){
    totalOrders = data.count;
    return data.count;
    
  }).then(function(count) {
    
    var numBatches = Math.ceil(totalOrders / BIGCOMMERCE_BATCH_SIZE);
    console.log('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(10).then(function() {
          var request = '/orders?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE + '&sort=date_created:desc';
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(order) {
    				orders.push(order);
          });
          return true;
        }, function(error) {
          console.log(error.message);
        });
      });
    });
    return promise;
    
  }).then(function() {
    console.log('Number of orders to search: ' + orders.length);
    var promise = Parse.Promise.as();
		_.each(orders, function(order) {
  		console.log('process orders id: ' + order.id);
  		promise = promise.then(function() {
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadOrder',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            order: order
          }
        });
    		
  		}).then(function(response) {
    		if (response.data.result.added) totalOrdersAdded++;
        return response;
        
      }, function(error) {
    		return "Error creating order: " + error.message;
  			
  		});
    });			
    return promise;
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalOrders + ' orders in Bigcommerce. ';
    message += orders.length + ' orders loaded. ';
    message += totalOrdersAdded + ' orders added. ';
    message += 'Job time: ' + jobTime;
    console.log(message);
    status.success(message);
  }, function(error) {
  	console.log(JSON.stringify(error));
		status.error(error.message);
  });
});

Parse.Cloud.job("updateDesigners", function(request, status) {
  var totalDesigners = 0;
  var totalDesignersAdded = 0;
  var designers = [];
  
  var startTime = moment();
  
  bigCommerce.get('/brands/count', function(err, data, response){
    totalDesigners = data.count;
    return data.count;
    
  }).then(function(count) {
    
    var numBatches = Math.ceil(totalDesigners / BIGCOMMERCE_BATCH_SIZE);
    console.log('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(10).then(function() {
          var request = '/brands?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE + '&sort=date_created:desc';
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(designer) {
    				designers.push(designer);
          });
          return true;
        }, function(error) {
          console.log(error.message);
        });
      });
    });
    return promise;
    
  }).then(function() {
    console.log('Number of designers to search: ' + designers.length);
    var promise = Parse.Promise.as();
		_.each(designers, function(designer) {
  		console.log('process designers id: ' + designer.id);
  		promise = promise.then(function() {
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadDesigner',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            designer: designer
          }
        });
    		
  		}).then(function(response) {
    		console.log(JSON.stringify(response));
    		if (response.data.result.added) totalDesignersAdded++;
        return response;
        
      }, function(error) {
    		return "Error creating designer: " + error.message;
  			
  		});
    });			
    return promise;
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalDesigners + ' designers in Bigcommerce. ';
    message += designers.length + ' designers loaded. ';
    message += totalDesignersAdded + ' designers added. ';
    message += 'Job time: ' + jobTime;
    console.log(message);
    status.success(message);
  }, function(error) {
  	console.log(JSON.stringify(error));
		status.error(error.message);
  });
});


/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getRecentJobs", function(request, response) {
  // Get most recent jobs
  var recentJobs = new Parse.Query(JobStatus);
  recentJobs.descending("createdAt");
  if (request.params.filter && request.params.filter != 'all') recentJobs.equalTo("status", request.params.filter);
  
  recentJobs.find({useMasterKey:true}).then(function(jobs) {
	  response.success(jobs);
	  
  }, function(error) {
	  response.error("Unable to save the model: " + error.message);
	  
  });
});

/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var delay = function(t) {
  return new Promise(function(resolve) { 
    setTimeout(resolve, t)
  });
}
