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
		_.each(products, function(product) {
      promise = promise.then(function() {
        var productQuery = new Parse.Query(Product);
        productQuery.equalTo('productId', product.id);
        return productQuery.first();
          
      }).then(function(productResult) {
        if (productResult) {
          console.log('Product ' + productResult.get('productId') + ' exists.');
          return createProductObject(product, productResult).save(null, {useMasterKey: true});
        } else {
          console.log('Product ' + product.id + ' is new.');
          totalProductsAdded++;
          return createProductObject(product).save(null, {useMasterKey: true});
        }
        
      }).then(function(productObject) {
        return totalProductsAdded;
        
      }, function(error) {
    		return "Error saving product: " + error.message;
  			
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
  productsQuery.equalTo('productId', 575);
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
    		console.log('do it');
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
    		
  		}).then(function(variantsAdded) {
    		totalProductsProcessed++;
    		variantsAdded += variantsAdded;
    		console.log('variantsAdded: ' + variantsAdded);
        return variantsAdded;
        
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

Parse.Cloud.job("updateOrders", function(request, status) {
  var totalOrders = 0;
  var totalOrdersAdded = 0;
  var orders = [];
  
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
      promise = promise.then(function() {
        var orderQuery = new Parse.Query(Order);
        orderQuery.equalTo('orderId', order.id);
        return orderQuery.first();
          
      }).then(function(orderResult) {
        if (orderResult) {
          console.log('Order ' + orderResult.get('orderId') + ' exists.');
          return createOrderObject(order, orderResult).save(null, {useMasterKey: true});
        } else {
          console.log('Order ' + order.id + ' is new.');
          totalOrdersAdded++;
          return createOrderObject(order).save(null, {useMasterKey: true});
        }
        
      }).then(function(orderObject) {
        return totalOrdersAdded;
        
      }, function(error) {
    		return "Error saving order: " + error.message;
  			
  		});
    });
    return promise;
    
  }).then(function() {
    var message = totalOrders + ' orders in Bigcommerce. ';
    message += orders.length + ' orders loaded. ';
    message += totalOrdersAdded + ' orders added. ';
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

var createProductObject = function(productData, currentProduct) {
  var productObj = (currentProduct) ? currentProduct : new Product();
  
  productObj.set('productId', productData.id);
  productObj.set('name', productData.name);
  productObj.set('sku', productData.sku);
  productObj.set('price', parseFloat(productData.price));
  productObj.set('cost_price', parseFloat(productData.cost_price));
  productObj.set('retail_price', parseFloat(productData.retail_price));
  productObj.set('sale_price', parseFloat(productData.sale_price));
  productObj.set('calculated_price', parseFloat(productData.calculated_price));
  productObj.set('is_visible', productData.is_visible);
  productObj.set('inventory_tracking', productData.inventory_tracking);
  productObj.set('total_sold', productData.total_sold);
  productObj.set('date_created', moment.utc(productData.date_created, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  productObj.set('brand_id', productData.brand_id);
  productObj.set('view_count', productData.view_count);
  productObj.set('categories', productData.categories);
  productObj.set('date_modified', moment.utc(productData.date_modified, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  productObj.set('condition', productData.condition);
  productObj.set('is_preorder_only', productData.is_preorder_only);
  productObj.set('custom_url', productData.custom_url);
  productObj.set('option_set_id', productData.option_set_id);
  productObj.set('primary_image', productData.primary_image);
  productObj.set('availability', productData.availability);
  return productObj;
}

var createOrderObject = function(orderData, currentOrder) {
  var order = (currentOrder) ? currentOrder : new Order();
  
  order.set('orderId', orderData.id);
  order.set('date_created', moment.utc(orderData.date_created, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  order.set('date_modified', moment.utc(orderData.date_modified, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  order.set('billing_address', orderData.billing_address);
  order.set('customer_id', orderData.customer_id);
  order.set('date_shipped', orderData.date_shipped);
  order.set('status_id', orderData.status_id);
  order.set('status', orderData.status);
  order.set('subtotal_ex_tax', parseFloat(orderData.subtotal_ex_tax));
  order.set('subtotal_inc_tax', parseFloat(orderData.subtotal_inc_tax));
  order.set('subtotal_tax', parseFloat(orderData.subtotal_tax));
  order.set('base_shipping_cost', parseFloat(orderData.base_shipping_cost));
  order.set('shipping_cost_ex_tax', parseFloat(orderData.shipping_cost_ex_tax));
  order.set('shipping_cost_inc_tax', parseFloat(orderData.shipping_cost_inc_tax));
  order.set('shipping_cost_tax', parseFloat(orderData.shipping_cost_tax));
  order.set('shipping_cost_tax_class_id', orderData.shipping_cost_tax_class_id);
  order.set('base_handling_cost', parseFloat(orderData.base_handling_cost));
  order.set('handling_cost_ex_tax', parseFloat(orderData.handling_cost_ex_tax));
  order.set('handling_cost_inc_tax', parseFloat(orderData.handling_cost_inc_tax));
  order.set('handling_cost_tax', parseFloat(orderData.handling_cost_tax));
  order.set('handling_cost_tax_class_id', orderData.handling_cost_tax_class_id);
  order.set('base_wrapping_cost', parseFloat(orderData.base_wrapping_cost));
  order.set('wrapping_cost_ex_tax', parseFloat(orderData.wrapping_cost_ex_tax));
  order.set('wrapping_cost_inc_tax', parseFloat(orderData.wrapping_cost_inc_tax));
  order.set('wrapping_cost_tax', parseFloat(orderData.wrapping_cost_tax));
  order.set('wrapping_cost_tax_class_id', orderData.wrapping_cost_tax_class_id);
  order.set('total_ex_tax', parseFloat(orderData.total_ex_tax));
  order.set('total_inc_tax', parseFloat(orderData.total_inc_tax));
  order.set('total_tax', parseFloat(orderData.total_tax));
  order.set('items_total', orderData.items_total);
  order.set('items_shipped', orderData.items_shipped);
  order.set('payment_method', orderData.payment_method);
  order.set('payment_provider_id', orderData.payment_provider_id);
  order.set('payment_status', orderData.payment_status);
  order.set('refunded_amount', parseFloat(orderData.refunded_amount));
  order.set('store_credit_amount', parseFloat(orderData.store_credit_amount));
  order.set('gift_certificate_amount', parseFloat(orderData.gift_certificate_amount));
  order.set('currency_id', orderData.currency_id);
  order.set('currency_code', orderData.currency_code);
  order.set('currency_exchange_rate', parseFloat(orderData.currency_exchange_rate));
  order.set('default_currency_id', orderData.default_currency_id);
  order.set('default_currency_code', orderData.default_currency_code);
  order.set('staff_notes', orderData.staff_notes);
  order.set('customer_message', orderData.customer_message);
  order.set('discount_amount', parseFloat(orderData.discount_amount));
  order.set('coupon_discount', parseFloat(orderData.coupon_discount));
  order.set('shipping_address_count', orderData.shipping_address_count);
  order.set('is_deleted', orderData.is_deleted);
  
  return order;
}