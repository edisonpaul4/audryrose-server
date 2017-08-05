var _ = require('underscore');
var moment = require('moment-timezone');
var request = require('request');
var cheerio = require('cheerio');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");

var Product = Parse.Object.extend('Product');
var ColorCode = Parse.Object.extend('ColorCode');
var StoneCode = Parse.Object.extend('StoneCode');
var SizeCode = Parse.Object.extend('SizeCode');
var MiscCode = Parse.Object.extend('MiscCode');
var Order = Parse.Object.extend('Order');
var VendorOrder = Parse.Object.extend('VendorOrder');
var JobStatus = Parse.Object.extend('_JobStatus');

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
const NUM_HOURS_TO_EXPIRE = 24;
const COLORS_IDS = [31, 3, 36, 30, 23];
const STONE_IDS = [33];
const SIZE_IDS = [32, 18];
const MISC_IDS = [35, 27, 26, 24];
const isProduction = process.env.NODE_ENV == 'production';
const isDebug = process.env.DEBUG == 'true';

/////////////////////////
//  BACKGROUND JOBS    //
/////////////////////////

Parse.Cloud.job("test", function(request, status) {
  logInfo('TEST INFO LOG');
  logError('TEST ERROR LOG', request);
  bigCommerce.get('/store', function(err, data, response){
    var message = "Successfully connected to " + data.name + ". The store id is " + data.id + ".";
    logInfo(message);
    status.success(message);
  }, function(error) {
  	logError(error);
		status.error(error);
  });
	
});

Parse.Cloud.job("updateProducts", function(request, status) {
  logInfo('updateProducts job --------------------------', true);
  var totalProducts = 0;
  var products = [];
  
  var startTime = moment();
  
  bigCommerce.get('/products/count', function(err, data, response){
    totalProducts = data.count;
    return data.count;
    
  }).then(function(count) {
    
    var numBatches = Math.ceil(totalProducts / BIGCOMMERCE_BATCH_SIZE);
    logInfo('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(1000).then(function() {
          var request = '/products?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE;
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(product) {
    				products.push(product.id);
          });
          return true;
        }, function(error) {
          logError(error);
        });
      });
    });
    return promise;
    
  }).then(function() {
    
    logInfo('Number of products to search: ' + products.length);
    var allPromises = [];
    var promise = Parse.Promise.as();
    //products = products.slice(0,5);// REMOVE
		_.each(products, function(productId) {
  		promise = promise.then(function() {
    		return Parse.Cloud.run('loadProduct', {productId: productId});
    		
  		}).then(function(result) {
        return true;
        
      }, function(error) {
        logError(error);
    		return error;
  			
  		});
  		allPromises.push(promise);
    });
    return Parse.Promise.when(allPromises);
    
  }).then(function() {
    
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalProducts + ' products in Bigcommerce. ';
    message += products.length + ' products loaded. ';
    message += 'Job time: ' + jobTime;
    logInfo(message, true);
    status.success(message);
  }, function(error) {
  	logError(error);
		status.error(error);
  });
});

Parse.Cloud.job("updateProductVariants", function(request, status) {
  logInfo('updateProductVariants job --------------------------', true);
  var totalProducts = 0;
  var totalProductsProcessed = 0;
  var totalVariantsAdded = 0;
  var products = [];
  
  var startTime = moment();
  var expireDate = moment().subtract(NUM_HOURS_TO_EXPIRE, 'hours');
  
  var neverUpdated = new Parse.Query(Product);
  neverUpdated.doesNotExist("variantsUpdatedAt");
	var expiredProducts = new Parse.Query(Product);
	expiredProducts.lessThan("variantsUpdatedAt", expireDate.toDate());
	var productsQuery = Parse.Query.or(neverUpdated, expiredProducts);
	productsQuery.ascending('variantsUpdatedAt');
  productsQuery.limit(1000);
  
  productsQuery.count().then(function(count) {
    totalProducts = count;
    logInfo("Total products need variants updated: " + totalProducts);
    return productsQuery.find({useMasterKey:true});
    
  }).then(function(products) {
    logInfo('Number of products to get variants: ' + products.length);
    var allPromises = [];
    var promise = Parse.Promise.as();
		_.each(products, function(product) {
  		logInfo('process product id: ' + product.get('productId'));
  		promise = promise.then(function() {
    		return Parse.Cloud.run('loadProductVariants', {productId: product.get('productId')});
    		
  		}).then(function(result) {
    		totalProductsProcessed++;
        return true;
        
      }, function(error) {
        logError(error);
    		return error;
  			
  		});
  		allPromises.push(promise);
    });		
		return Parse.Promise.when(allPromises);
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalProducts + ' products need variants updated. ';
    message += totalProductsProcessed + ' products processed. ';
    message += 'Job time: ' + jobTime;
    logInfo(message, true);
    status.success(message);
    
  }, function(error) {
    logError(error);
	  status.error(error);
  });
  
});

Parse.Cloud.job("updateCategories", function(request, status) {
  logInfo('updateCategories job --------------------------', true);
  var totalCategories = 0;
  var totalCategoriesAdded = 0;
  var categories = [];
  
  var startTime = moment();
  
  bigCommerce.get('/categories/count', function(err, data, response){
    totalCategories = data.count;
    return data.count;
    
  }).then(function(count) {
    
    var numBatches = Math.ceil(totalCategories / BIGCOMMERCE_BATCH_SIZE);
    logInfo('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(1000).then(function() {
          var request = '/categories?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE;
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(category) {
    				categories.push(category);
          });
          return true;
        }, function(error) {
          logError(error);
        });
      });
    });
    return promise;
    
  }).then(function() {
    logInfo('Number of categories to search: ' + categories.length);
    var allPromises = [];
    var promise = Parse.Promise.as();
		_.each(categories, function(category) {
  		logInfo('process category id: ' + category.id);
  		promise = promise.then(function() {
    		return Parse.Cloud.run('loadCategory', {category: category});
    		
  		}).then(function(result) {
    		if (result.added) totalCategoriesAdded++;
        return true;
        
      }, function(error) {
    		logError(error);
    		return error;
  			
  		});
  		allPromises.push(promise);
    });
    return Parse.Promise.when(allPromises);
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalCategories + ' categories in Bigcommerce. ';
    message += categories.length + ' categories loaded. ';
    message += totalCategoriesAdded + ' categories added. ';
    message += 'Job time: ' + jobTime;
    logInfo(message, true);
    status.success(message);
  }, function(error) {
  	logError(error);
		status.error(error);
  });
});

Parse.Cloud.job("updateShippedOrders", function(request, status) {
  logInfo('updateShippedOrders job --------------------------', true);
  var totalOrders = 0;
  var ordersToProcess = 0;
  var totalOrdersAdded = 0;
  var orderIds = [];
  
  var startTime = moment();
  
  var request = '/orders/count';
  
  bigCommerce.get('/orders/count', function(err, data, response){
    totalOrders = data.count;
    logInfo(totalOrders);
    return totalOrders;
    
  }).then(function(count) {
    //ordersToProcess = totalOrders > 1000 ? 1000 : totalOrders; // Uncomment this to limit number of orders
    ordersToProcess = totalOrders; // Uncomment this to process all orders
    logInfo('Total orders to process: ' + ordersToProcess);
    var numBatches = Math.ceil(ordersToProcess / BIGCOMMERCE_BATCH_SIZE);
    logInfo('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(1000).then(function() {
          var request = '/orders?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE + '&sort=date_created:desc&status_id=2&is_deleted=false';
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(order) {
    				orderIds.push(order.id);
          });
          return true;
        }, function(error) {
          logError(error);
        });
      });
    });
    return promise;
    
  }).then(function() {
    //orderIds = orderIds.slice(0,5); // REMOVE THIS ONLY FOR TESTING
    logInfo('Number of orders to search: ' + orderIds.length);
    var promise = Parse.Promise.as();
		_.each(orderIds, function(orderId) {
  		logInfo('process orders id: ' + orderId);
  		promise = promise.then(function() {
    		return Parse.Cloud.run('loadOrder', {orderId: orderId});
    		
  		}).then(function(result) {
    		if (result.added) totalOrdersAdded++;
        return true;
        
      }, function(error) {
    		logError(error);
    		return error;
  			
  		});
    });			
    return promise;
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalOrders + ' orders in Bigcommerce. ';
    message += orderIds.length + ' orders loaded. ';
    message += totalOrdersAdded + ' orders added. ';
    message += 'Job time: ' + jobTime;
    logInfo(message, true);
    status.success(message);
  }, function(error) {
  	logError(error);
		status.error(error);
  });
});

Parse.Cloud.job("updateRecentOrders", function(request, status) {
  logInfo('updateRecentOrders job --------------------------', true);
  var totalOrders = 0;
  var totalOrdersAdded = 0;
  var orderIds = [];
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
    
    logInfo('Number of requests: ' + orderStatuses.length);
    
    var promise = Parse.Promise.as();
    _.each(orderStatuses, function(orderStatusRequest) {
      promise = promise.then(function() {
        return delay(500).then(function() {
          var request = '/orders?limit=' + BIGCOMMERCE_BATCH_SIZE + '&sort=date_created:desc' + '&status_id=' + orderStatusRequest.id;
          return bigCommerce.get(request);
        }).then(function(response) {
          logInfo(response.length + ' orders for status ' + orderStatusRequest.name);
  				_.each(response, function(order) {
    				orderIds.push(order.id);
          });
          return true;
        }, function(error) {
          logError(error);
        });
      });
    });
    return promise;
    
  }).then(function() {
    
    logInfo('Number of orders to search: ' + orderIds.length);
    //orderIds = orderIds.slice(0,5); // REMOVE THIS, ONLY FOR TESTING
//     return true;
    var promise = Parse.Promise.as();
		_.each(orderIds, function(orderId) {
  		promise = promise.then(function() {
    		return Parse.Cloud.run('loadOrder', {orderId: orderId});
    		
  		}).then(function(result) {
    		if (result.added) totalOrdersAdded++;
    		return true;
        
      }, function(error) {
    		logError(error);
  			
  		});
    });			
    return promise;
    
  }).then(function() {
    
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalOrders + ' orders in Bigcommerce. ';
    message += orderIds.length + ' orders loaded. ';
    message += totalOrdersAdded + ' orders added. ';
    message += 'Job time: ' + jobTime;
    logInfo(message, true);
    status.success(message);
    
  }, function(error) {
  	logError(error);
		status.error(error);
  });
});

Parse.Cloud.job("updateDesigners", function(request, status) {
  logInfo('updateDesigners job --------------------------', true);
  var totalDesigners = 0;
  var totalDesignersAdded = 0;
  var designers = [];
  
  var startTime = moment();
  
  bigCommerce.get('/brands/count', function(err, data, response){
    totalDesigners = data.count;
    return data.count;
    
  }).then(function(count) {
    
    var numBatches = Math.ceil(totalDesigners / BIGCOMMERCE_BATCH_SIZE);
    logInfo('Number of batches: ' + numBatches);
    
    var promise = Parse.Promise.as();
    var pages = Array.apply(null, {length: numBatches}).map(Number.call, Number);
    _.each(pages, function(page) {
      page++;
      promise = promise.then(function() {
        return delay(500).then(function() {
          var request = '/brands?page=' + page + '&limit=' + BIGCOMMERCE_BATCH_SIZE + '&sort=date_created:desc';
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(designer) {
    				designers.push(designer);
          });
          return true;
        }, function(error) {
          logError(error);
        });
      });
    });
    return promise;
    
  }).then(function() {
    logInfo('Number of designers to search: ' + designers.length);
    var promise = Parse.Promise.as();
		_.each(designers, function(designer) {
  		logInfo('process designers id: ' + designer.id);
  		promise = promise.then(function() {
    		return Parse.Cloud.run('loadDesigner', {designer: designer});
    		
  		}).then(function(result) {
    		if (result.added) totalDesignersAdded++;
        return true;
        
      }, function(error) {
    		logError(error);
    		return error;
  			
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
    logInfo(message, true);
    status.success(message);
  }, function(error) {
  	logError(error);
		status.error(error);
  });
});

Parse.Cloud.job("updateOptions", function(request, status) {
  logInfo('updateOptions job --------------------------', true);
  var totalOptionsAdded = 0;
  var colorOptionValues = [];
  var stoneOptionValues = [];
  var sizeOptionValues = [];
  var miscOptionValues = [];
  var bcOptions = [];
  
  var allIds = COLORS_IDS.concat(STONE_IDS);
  allIds = allIds.concat(SIZE_IDS);
  allIds = allIds.concat(MISC_IDS);
  var totalOptions = allIds.length;
  
  var startTime = moment();
  
  bigCommerce.get('/options/count', function(err, data, response){
    logInfo('Number of options: ' + totalOptions);
    return data.count;
    
  }).then(function(count) {
    return bigCommerce.get('/options?limit=' + BIGCOMMERCE_BATCH_SIZE);
    
  }).then(function(optionResults) {
    bcOptions = optionResults;
    
    var promise = Parse.Promise.as();
    _.each(allIds, function(id) {
      promise = promise.then(function() {
        return delay(500).then(function() {
          var request = '/options/' + id + '/values?limit=' + BIGCOMMERCE_BATCH_SIZE;
          return bigCommerce.get(request);
        }).then(function(response) {
  				_.each(response, function(option) {
    				if (COLORS_IDS.indexOf(id) >= 0) colorOptionValues.push(option);
    				if (STONE_IDS.indexOf(id) >= 0) stoneOptionValues.push(option);
    				if (SIZE_IDS.indexOf(id) >= 0) sizeOptionValues.push(option);
    				if (MISC_IDS.indexOf(id) >= 0) miscOptionValues.push(option);
          });
          return true;
        }, function(error) {
          logError(error);
        });
      });
    });
    return promise;
    
  }).then(function() {
    logInfo('Number of color options to search: ' + colorOptionValues.length);
    
    var promise = Parse.Promise.as();
		_.each(colorOptionValues, function(colorOptionValue) {
  		logInfo('process color options id: ' + colorOptionValue.id);
  		promise = promise.then(function() {
    		return delay(50).then(function() {
          var query = new Parse.Query(ColorCode);
          query.equalTo('option_id', parseInt(colorOptionValue.option_id));
          query.equalTo('option_value_id', parseInt(colorOptionValue.id));
          return query.first();
          
        }).then(function(result) {
          if (result) {
            logInfo('ColorCode exists.');
            return createOptionObject(bcOptions, colorOptionValue, 'color', result).save(null, {useMasterKey: true});
          } else {
            logInfo('ColorCode is new.');
            totalOptionsAdded++;
            return createOptionObject(bcOptions, colorOptionValue, 'color').save(null, {useMasterKey: true});
          }
      		
    		}).then(function(response) {
          return true;
          
        }, function(error) {
      		logError(error);
      		return error;
    			
    		});
  		});
    });			
    return promise;
    
  }).then(function() {
    logInfo('Number of stone options to search: ' + stoneOptionValues.length);
    
    var promise = Parse.Promise.as();
		_.each(stoneOptionValues, function(stoneOptionValue) {
  		logInfo('process stone options id: ' + stoneOptionValue.id);
  		promise = promise.then(function() {
    		return delay(50).then(function() {
          var query = new Parse.Query(StoneCode);
          query.equalTo('option_id', parseInt(stoneOptionValue.option_id));
          query.equalTo('option_value_id', parseInt(stoneOptionValue.id));
          return query.first();

        }).then(function(result) {
          if (result) {
            logInfo('StoneCode exists.');
            return createOptionObject(bcOptions, stoneOptionValue, 'stone', result).save(null, {useMasterKey: true});
          } else {
            logInfo('StoneCode is new.');
            totalOptionsAdded++;
            return createOptionObject(bcOptions, stoneOptionValue, 'stone').save(null, {useMasterKey: true});
          }
      		
    		}).then(function(response) {
          return response;
          
        }, function(error) {
          logError(error);
      		return error;
    			
    		});
  		});
    });			
    return promise;
    
  }).then(function() {
    logInfo('Number of size options to search: ' + sizeOptionValues.length);
    
    var promise = Parse.Promise.as();
		_.each(sizeOptionValues, function(sizeOptionValue) {
  		logInfo('process size options id: ' + sizeOptionValue.id);
  		promise = promise.then(function() {
    		return delay(50).then(function() {
          var query = new Parse.Query(SizeCode);
          query.equalTo('option_id', parseInt(sizeOptionValue.option_id));
          query.equalTo('option_value_id', parseInt(sizeOptionValue.id));
          return query.first();

        }).then(function(result) {
          if (result) {
            logInfo('SizeCode exists.');
            return createOptionObject(bcOptions, sizeOptionValue, 'size', result).save(null, {useMasterKey: true});
          } else {
            logInfo('SizeCode is new.');
            totalOptionsAdded++;
            return createOptionObject(bcOptions, sizeOptionValue, 'size').save(null, {useMasterKey: true});
          }
      		
    		}).then(function(response) {
          return response;
          
        }, function(error) {
          logError(error);
      		return error;
    			
    		});
  		});
    });			
    return promise;
    
  }).then(function() {
    logInfo('Number of misc options to search: ' + miscOptionValues.length);
    
    var promise = Parse.Promise.as();
		_.each(miscOptionValues, function(miscOptionValue) {
  		logInfo('process misc options id: ' + miscOptionValue.id);
  		promise = promise.then(function() {
    		return delay(50).then(function() {
          var query = new Parse.Query(MiscCode);
          query.equalTo('option_id', parseInt(miscOptionValue.option_id));
          query.equalTo('option_value_id', parseInt(miscOptionValue.id));
          return query.first();

        }).then(function(result) {
          if (result) {
            logInfo('MiscCode exists.');
            return createOptionObject(bcOptions, miscOptionValue, 'misc', result).save(null, {useMasterKey: true});
          } else {
            logInfo('MiscCode is new.');
            totalOptionsAdded++;
            return createOptionObject(bcOptions, miscOptionValue, 'misc').save(null, {useMasterKey: true});
          }
      		
    		}).then(function(response) {
          return response;
          
        }, function(error) {
          logError(error);
      		return error;
    			
    		});
  		});
    });			
    return promise;
    
  }).then(function() {
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    message = totalOptionsAdded + ' options added. ';
    message += 'Job time: ' + jobTime;
    logInfo(message, true);
    status.success(message);
    
  }, function(error) {
  	logError(error);
		status.error(error);
  });
});

Parse.Cloud.job("updateVendorOrders", function(request, status) {
  logInfo('updateVendorOrders job --------------------------', true);
  var startTime = moment();
  var vendors = [];
  var vendorOrders = [];  
  var vendorOrderVariants = [];
  
  var vendorOrderQuery = new Parse.Query(VendorOrder);
  vendorOrderQuery.include('vendorOrderVariants');
  vendorOrderQuery.include('vendor');
  vendorOrderQuery.ascending('createdAt');
  vendorOrderQuery.limit(10000);
  vendorOrderQuery.find().then(function(results) {
    if (results) vendorOrders = results;
    _.each(vendorOrders, function(vendorOrder) {
      _.each(vendorOrder.get('vendorOrderVariants'), function(vendorOrderVariant) {
        vendorOrderVariant.set('vendorOrder', vendorOrder);
        vendorOrderVariants.push(vendorOrderVariant);
      });
    });
    return Parse.Object.saveAll(vendorOrderVariants, {useMasterKey: true});
    
  }).then(function(results) {
    var promise = Parse.Promise.as();
    _.each(vendorOrders, function(vendorOrder) {
      promise = promise.then(function() {
        return vendorOrder.save(null, {useMasterKey:true});
      });
    });
    return promise;
    
  }).then(function(result) {
    var message = vendorOrderVariants.length + ' vendorOrderVariants saved. updateVendorOrders completion time: ' + moment().diff(startTime, 'seconds') + ' seconds';
    logInfo(message, true);
    status.success(message);
  });
  
});

Parse.Cloud.job("updateAwaitingInventoryQueue", function(request, status) {
  logInfo('updateAwaitingInventoryQueue job --------------------', true);
  var startTime = moment();
  
  var bcOrderId = request.params.orderId;
  
  Parse.Cloud.run('updateAwaitingInventoryQueue').then(function(res) {
    completed = true;
    status.success('updateAwaitingInventoryQueue completion time: ' + moment().diff(startTime, 'seconds') + ' seconds');
    
  }, function(error) {
    logError(error);
    status.error(error.message);
		
	});
});

Parse.Cloud.job("removeDuplicateOrders", function(request, status) {
  logInfo('removeDuplicateOrders job --------------------------', true);
  var totalOrders = 0;
  var totalOrdersRemoved = 0;
  var ordersToRemove = [];
  
  var startTime = moment();
    
  var ordersQuery = new Parse.Query(Order);
  ordersQuery.descending('updatedAt');
  ordersQuery.limit(5000);
  ordersQuery.find().then(function(orders) {
    var orderIds = [];
    var duplicateOrders = [];
    _.each(orders, function(order) {
      if (orderIds.indexOf(order.get('orderId')) >= 0) {
        duplicateOrders.push(order);
      } else {
        orderIds.push(order.get('orderId'));
      }
    });
    
    logInfo('There are ' + duplicateOrders.length + ' duplicate orders');
    
    _.each(duplicateOrders, function(duplicateOrder) {
      var orderShipments = duplicateOrder.has('orderShipments') ? duplicateOrder.get('orderShipments') : [];
      var isOldest = true;
      var hasLeastShipments = true;
      _.each(orders, function(order) {
        if (order.get('orderId') === duplicateOrder.get('orderId')) {
          // Make sure duplicate order is the the oldest
          if (moment(order.get('date_modified')).isBefore(moment(duplicateOrder.get('date_modified')))) {
            isOldest = false;
          }
          // Make sure duplicate order does not have more shipments than others
          if (order.has('orderShipments') && orderShipments.length > order.get('orderShipments').length) {
            hasLeastShipments = false;
          }
        }
      });
      var remove = isOldest && hasLeastShipments;
      logInfo('order ' + duplicateOrder.get('orderId') + ' to be removed: ' + remove, true);
      if (remove) ordersToRemove.push(duplicateOrder);
    });
    
    if (ordersToRemove.length > 0) {
      return Parse.Object.destroyAll(ordersToRemove)
    } else {
      return false;
    }
    
 }).then(function() {
    logInfo(ordersToRemove.length + ' orders removed');
    var message = 'removeDuplicateOrders completion time: ' + moment().diff(startTime, 'seconds') + ' seconds';
    logInfo(message, true);
    status.success(message);
    
  }, function(error){
    logError(error);
    status.error(error);
  });
});

Parse.Cloud.job("removeDuplicateProducts", function(request, status) {
  logInfo('removeDuplicateProducts job --------------------------', true);
  var totalProductsRemoved = 0;
  var productsToRemove = [];
  
  var startTime = moment();
    
  var productsQuery = new Parse.Query(Product);
  productsQuery.descending('updatedAt');
  productsQuery.limit(5000);
  productsQuery.find().then(function(products) {
    var productIds = [];
    var duplicateProducts = [];
    _.each(products, function(product) {
      if (productIds.indexOf(product.get('productId')) >= 0) {
        duplicateProducts.push(product);
      } else {
        productIds.push(product.get('productId'));
      }
    });
    
    logInfo('There are ' + duplicateProducts.length + ' duplicate products');
    
    _.each(duplicateProducts, function(duplicateProduct) {
      var productShipments = duplicateProduct.has('productShipments') ? duplicateProduct.get('productShipments') : [];
      var isOldest = true;
      var hasNoVendorOrders = true;
      _.each(products, function(product) {
        if (product.get('productId') === duplicateProduct.get('productId')) {
          // Make sure duplicate product is the the oldest
          if (moment(product.get('date_modified')).isBefore(moment(duplicateProduct.get('date_modified')))) {
            isOldest = false;
          }
          // Make sure duplicate product does not have any vendor orders
          if (product.has('hasVendorOrder') && product.get('hasVendorOrder') == true) {
            hasNoVendorOrders = false;
          }
        }
      });
      var remove = isOldest && hasNoVendorOrders;
      logInfo('product ' + duplicateProduct.get('productId') + ' to be removed: ' + remove, true);
      if (remove) productsToRemove.push(duplicateProduct);
    });

    if (productsToRemove.length > 0) {
      return Parse.Object.destroyAll(productsToRemove)
    } else {
      return false;
    }
    
 }).then(function() {
    logInfo(productsToRemove.length + ' products removed');
    var message = 'removeDuplicateProducts completion time: ' + moment().diff(startTime, 'seconds') + ' seconds';
    logInfo(message, true);
    status.success(message);
    
  }, function(error){
    logError(error);
    status.error(error);
  });
});

Parse.Cloud.job("removeIncompleteOrders", function(request, status) {
  logInfo('removeIncompleteOrders job --------------------------', true);
  var totalOrdersToRemove = 0;
  var totalOrdersRemoved = 0;
  var orderIds = [];
  var orderStatuses = [
    {name: 'Incomplete', id: '0'},
    {name: 'Pending', id: '1'}
  ];
  
  var startTime = moment();
  
	var orderQuery = new Parse.Query(Order);
	orderQuery.containedIn('status_id', [0,1]);
	orderQuery.ascending('orderId');
	orderQuery.limit(250);
	orderQuery.find().then(function(results) {
  	orderIds = results.map((result) => result.get('orderId'));
  	
    totalOrdersToRemove = orderIds.length;
    logInfo('Number of orders to remove: ' + totalOrdersToRemove);
    var promise = Parse.Promise.as();
		_.each(orderIds, function(orderId) {
  		promise = promise.then(function() {
    		var orderQuery = new Parse.Query(Order);
    		orderQuery.equalTo('orderId', orderId);
    		return orderQuery.first();
    		
  		}).then(function(result) {
    		if (result) {
      		logInfo('remove order ' + orderId + ' with status ' + result.get('status'), true);
      		return result.destroy(null, {useMasterKey: true});
    		} else {
      		return false;
    		}
  		}).then(function(result) {
    		if (result) totalOrdersRemoved++;
    		return true;
        
      }, function(error) {
    		logError(error);
  			
  		});
    });			
    return promise;
    
  }).then(function() {
    
    var now = moment();
    var jobTime = moment.duration(now.diff(startTime)).humanize();
    var message = totalOrdersToRemove + ' orders to remove. ';
    message += totalOrdersRemoved + ' orders removed. ';
    message += 'Job time: ' + jobTime;
    logInfo(message, true);
    status.success(message);
    
  }, function(error) {
  	logError(error);
		status.error(error);
  });
});


/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getRecentJobs", function(request, response) {
  logInfo('getRecentJobs cloud function --------------------------', true);
  // Get most recent jobs
  var recentJobs = new Parse.Query(JobStatus);
  recentJobs.descending("createdAt");
  if (request.params.filter && request.params.filter != 'all') recentJobs.equalTo("status", request.params.filter);
  
  recentJobs.find({useMasterKey:true}).then(function(jobs) {
	  response.success(jobs);
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);	  
  });
});

Parse.Cloud.define("getJobStatus", function(request, response) {
  var jobId = request.params.jobId;

  var jobsQuery = new Parse.Query(JobStatus);
  jobsQuery.equalTo('objectId', jobId)
  
  jobsQuery.first({useMasterKey:true}).then(function(job) {
	  response.success(job ? job.toJSON() : null);
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);	  
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
      case 'size':
        option = new SizeCode();
        break;
      case 'misc':
        option = new MiscCode();
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
  cleanedLabel = cleanedLabel.replace(/\"/g, ' ');
  cleanedLabel = cleanedLabel.replace(/\+/g, ' ');
  var firstLetters = cleanedLabel.match(/\b(\w)/g);
  var firstTwoLetters = cleanedLabel.match(/\b(\S\w)/g);
  if (firstLetters && !isNaN(firstLetters[0])) firstLetters[0] = cleanedLabel.slice(0, cleanedLabel.indexOf(' '));
  if (firstTwoLetters && !isNaN(firstTwoLetters[0])) firstTwoLetters[0] = cleanedLabel.slice(0, cleanedLabel.indexOf(' '));
    
  switch (type) {
    case 'color':
      // Return first 1 letter of each word
      return firstLetters.length > 1 ? firstLetters.join('') : cleanedLabel;
      break;
    case 'stone':
      // Return first 2 letters of first word, and first 1 letter of 2nd
      return firstTwoLetters && firstTwoLetters.length > 1 ? firstTwoLetters[0] + firstLetters[1] : cleanedLabel;
      break;
    case 'size':
      // Return size
      return label;
      break;
    case 'misc':
      // Return first 2 letters of first word, and first 1 letter of 2nd
      return firstTwoLetters && firstTwoLetters.length > 1 ? firstTwoLetters[0] + firstLetters[1] : cleanedLabel;
      break;
    default:
      console.error("Error with getOptionCode: Option type was not provided.");
      return '[ERROR]';
  }
}

var logInfo = function(i, alwaysLog) {
  if (!isProduction || isDebug || alwaysLog) console.info(i);
}

var logError = function(e) {
  console.error(e);
	if (isProduction) bugsnag.notify(e);
}