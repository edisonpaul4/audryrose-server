var _ = require('underscore');
var moment = require('moment');
var request = require('request');
var cheerio = require('cheerio');
var BigCommerce = require('node-bigcommerce');

var Product = Parse.Object.extend('Product');
var ColorCode = Parse.Object.extend('ColorCode');
var StoneCode = Parse.Object.extend('StoneCode');
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
const NUM_DAYS_TO_EXPIRE = 1;
const COLORS_IDS = [31, 3, 36, 30, 23];
const STONE_IDS = [33];

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
    //products = products.slice(0,25);// REMOVE
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
  var expireDate = moment().subtract(NUM_DAYS_TO_EXPIRE, 'day');
  
  var neverUpdated = new Parse.Query(Product);
  neverUpdated.doesNotExist("variantsUpdatedAt");
	var expiredProducts = new Parse.Query(Product);
	expiredProducts.lessThan("variantsUpdatedAt", expireDate.toDate());
	var productsQuery = Parse.Query.or(neverUpdated, expiredProducts);
	productsQuery.ascending('variantsUpdatedAt');
  productsQuery.limit(500); // 500
  
  productsQuery.count().then(function(count) {
    totalProducts = count;
    console.log("Total products need variants updated: " + totalProducts);
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
    var message = totalProducts + ' products need variants updated. ';
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

Parse.Cloud.job("updateShippedOrders", function(request, status) {
  var totalOrders = 0;
  var ordersToProcess = 0;
  var totalOrdersAdded = 0;
  var orders = [];
  
  var startTime = moment();
  
  var request = '/orders/count';
  
  bigCommerce.get('/orders/count', function(err, data, response){
    totalOrders = data.count;
    console.log(totalOrders);
    return totalOrders;
    
  }).then(function(count) {
    //ordersToProcess = totalOrders > 1000 ? 1000 : totalOrders; // Uncomment this to limit number of orders
    ordersToProcess = totalOrders; // Uncomment this to process all orders
    console.log('Total orders to process: ' + ordersToProcess);
    var numBatches = Math.ceil(ordersToProcess / BIGCOMMERCE_BATCH_SIZE);
    console.log('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(10).then(function() {
          var request = '/orders?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE + '&sort=date_created:desc&status_id=2&is_deleted=false';
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
    //orders = orders.slice(0,5); // REMOVE THIS ONLY FOR TESTING
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

Parse.Cloud.job("updateRecentOrders", function(request, status) {
  var totalOrders = 0;
  var totalOrderProductsAdded = 0;
  var orders = [];
  var orderStatuses = [
    {name: 'Awaiting Pickup', id: '8'},
    {name: 'Awaiting Shipment', id: '9'},
    {name: 'Awaiting Fulfillment', id: '11'},
    {name: 'Partially Shipped', id: '3'},
    {name: 'Pending', id: '1'},
    {name: 'Shipped', id: '2'}
  ];
  
  var startTime = moment();
  
  var request = '/orders/count';
  
  bigCommerce.get('/orders/count', function(err, data, response){
    totalOrders = data.count;
    return totalOrders;
    
  }).then(function(count) {
    console.log('Number of requests: ' + orderStatuses.length);
    
    var promise = Parse.Promise.as();
    _.each(orderStatuses, function(orderStatusRequest) {
      promise = promise.then(function() {
        return delay(10).then(function() {
          var request = '/orders?limit=' + BIGCOMMERCE_BATCH_SIZE + '&sort=date_created:desc' + '&status_id=' + orderStatusRequest.id;
          return bigCommerce.get(request);
        }).then(function(response) {
          console.log(response.length + ' orders for status ' + orderStatusRequest.name);
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
    //orders = orders.slice(0,5); // REMOVE THIS, ONLY FOR TESTING
//     return true;
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
    message += totalOrderProductsAdded + ' orders added. ';
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

Parse.Cloud.job("updateOptions", function(request, status) {
  var totalOptionsAdded = 0;
  var colorOptionValues = [];
  var stoneOptionValues = [];
  var bcOptions = [];
  
  var allIds = COLORS_IDS.concat(STONE_IDS);
  var totalOptions = allIds.length;
  
  var startTime = moment();
  
  bigCommerce.get('/options/count', function(err, data, response){
    console.log('Number of options: ' + totalOptions);
    return data.count;
    
  }).then(function(count) {
    return bigCommerce.get('/options?limit=' + BIGCOMMERCE_BATCH_SIZE);
    
  }).then(function(optionResults) {
    bcOptions = optionResults;
    
    var promise = Parse.Promise.as();
    _.each(allIds, function(id) {
      promise = promise.then(function() {
        return delay(10).then(function() {
          var request = '/options/' + id + '/values?limit=' + BIGCOMMERCE_BATCH_SIZE;
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(option) {
    				if (COLORS_IDS.indexOf(id) >= 0) colorOptionValues.push(option);
    				if (STONE_IDS.indexOf(id) >= 0) stoneOptionValues.push(option);
          });
          return true;
        }, function(error) {
          console.log(error.message);
        });
      });
    });
    return promise;
    
  }).then(function() {
    console.log('Number of color options to search: ' + colorOptionValues.length);
    
    var promise = Parse.Promise.as();
		_.each(colorOptionValues, function(colorOptionValue) {
  		console.log('process color options id: ' + colorOptionValue.id);
  		promise = promise.then(function() {
    		return delay(10).then(function() {
          var colorCodeQuery = new Parse.Query(ColorCode);
          colorCodeQuery.equalTo('option_id', parseInt(colorOptionValue.option_id));
          colorCodeQuery.equalTo('option_value_id', parseInt(colorOptionValue.id));
          return colorCodeQuery.first();
          
        }).then(function(colorCodeResult) {
          if (colorCodeResult) {
            console.log('ColorCode exists.');
            return createOptionObject(bcOptions, colorOptionValue, 'color', colorCodeResult).save(null, {useMasterKey: true});
          } else {
            console.log('ColorCode is new.');
            totalOptionsAdded++;
            return createOptionObject(bcOptions, colorOptionValue, 'color').save(null, {useMasterKey: true});
          }
      		
    		}).then(function(response) {
          return response;
          
        }, function(error) {
      		return "Error creating ColorCode: " + error.message;
    			
    		});
  		});
    });			
    return promise;
    
  }).then(function() {
    console.log('Number of stone options to search: ' + stoneOptionValues.length);
    
    var promise = Parse.Promise.as();
		_.each(stoneOptionValues, function(stoneOptionValue) {
  		console.log('process stone options id: ' + stoneOptionValue.id);
  		promise = promise.then(function() {
    		return delay(10).then(function() {
          var stoneCodeQuery = new Parse.Query(StoneCode);
          stoneCodeQuery.equalTo('option_id', parseInt(stoneOptionValue.option_id));
          stoneCodeQuery.equalTo('option_value_id', parseInt(stoneOptionValue.id));
          return stoneCodeQuery.first();

        }).then(function(stoneCodeResult) {
          if (stoneCodeResult) {
            console.log('StoneCode exists.');
            return createOptionObject(bcOptions, stoneOptionValue, 'stone', stoneCodeResult).save(null, {useMasterKey: true});
          } else {
            console.log('StoneCode is new.');
            totalOptionsAdded++;
            return createOptionObject(bcOptions, stoneOptionValue, 'stone').save(null, {useMasterKey: true});
          }
      		
    		}).then(function(response) {
          return response;
          
        }, function(error) {
      		return "Error creating StoneCode: " + error.message;
    			
    		});
  		});
    });			
    return promise;
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    message = totalOptionsAdded + ' options added. ';
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

var createOptionObject = function(bcOptions, optionData, type, currentOption) {
  var option;
  if (currentOption) {
    option = currentOption;
  } else {
    switch (type) {
      case 'color':
        option = new ColorCode();
        break;
      case 'stone':
        option = new StoneCode();
        break;
      default:
        return false;
    }
  }
  var displayName;
  var name;
  _.map(bcOptions, function(bcOption) {
    if (parseInt(bcOption.id) == parseInt(optionData.option_id)) {
      displayName = bcOption.display_name;
      name = bcOption.name;
    }
    return true;
  });
  option.set('display_name', displayName);
  option.set('option_name', name);
  option.set('option_id', parseInt(optionData.option_id));
  option.set('option_value_id', parseInt(optionData.id));
  option.set('label', optionData.label);
  option.set('value', optionData.value);
  
  option.set('generatedCode', getOptionCode(type, optionData.label));
  
  return option;
}

var getOptionCode = function(type, label) {
  var cleanedLabel = label.toLowerCase();
  cleanedLabel = cleanedLabel.replace(/-/g, ' ');
  cleanedLabel = cleanedLabel.replace(/\//g, ' ');
  cleanedLabel = cleanedLabel.replace(/\./g, ' ');
  var firstLetters = cleanedLabel.match(/\b(\w)/g);
  var firstTwoLetters = cleanedLabel.match(/\b(\S\w)/g);
  if (!isNaN(firstLetters[0])) firstLetters[0] = cleanedLabel.slice(0, cleanedLabel.indexOf(' '));
  if (!isNaN(firstTwoLetters[0])) firstTwoLetters[0] = cleanedLabel.slice(0, cleanedLabel.indexOf(' '));
    
  switch (type) {
    case 'color':
      // Return first 1 letter of each word
      return firstLetters.length > 1 ? firstLetters.join('') : cleanedLabel;
      break;
    case 'stone':
      // Return first 2 letters of first word, and first 1 letter of 2nd
      return firstTwoLetters.length > 1 ? firstTwoLetters[0] + firstLetters[1] : cleanedLabel;
      break;
    default:
      return '[ERROR]';
  }
}