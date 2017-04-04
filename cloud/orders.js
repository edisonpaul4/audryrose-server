var _ = require('underscore');
var moment = require('moment');
var numeral = require('numeral');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");
var hummus = require('hummus');
var streams = require('memory-streams');
var PDFRStreamForBuffer = require('../lib/pdfr-stream-for-buffer.js');
// var memwatch = require('memwatch-next');

var Order = Parse.Object.extend('Order');
var OrderProduct = Parse.Object.extend('OrderProduct');
var OrderShipment = Parse.Object.extend('OrderShipment');
var Product = Parse.Object.extend('Product');
var ProductVariant = Parse.Object.extend('ProductVariant');

const ORDERS_PER_PAGE = 50;

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
const CUSTOM_PRODUCT_OPTIONS = [28];
const SIZE_PRODUCT_OPTIONS = [18,32,24];
const US_SHIPPING_ZONES = [1];

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getOrders", function(request, response) {
  var totalOrders;
  var totalPages;
  var tabCounts;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'date-added-desc';
  var search = request.params.search ? request.params.search : null;
  var subpage = request.params.subpage ? request.params.subpage : 'awaiting-fulfillment';
  var paginate = true;
  
  var ordersQuery = new Parse.Query(Order);
  
  if (search) {
    
    var toLowerCase = function(w) { return w.toLowerCase(); };
    
    var regex = new RegExp(search.toLowerCase(), 'gi');
    var searchTerms = search.split(' ');
    searchTerms = _.map(searchTerms, toLowerCase);
    
    logInfo(searchTerms);
    
    var searchOrderNumberQuery = new Parse.Query(Order);
    searchOrderNumberQuery.matches('orderId', regex);
    var searchTermsQuery = new Parse.Query(Order);
    searchTermsQuery.containedIn('search_terms', searchTerms);
    ordersQuery = Parse.Query.or(searchOrderNumberQuery, searchTermsQuery);
    
  } else {
    
    logInfo(subpage);
    switch (subpage) {
      case 'fulfilled':
        ordersQuery.equalTo('status', 'Shipped');
        break;
      case 'awaiting-fulfillment':
        ordersQuery = getPendingOrderQuery();
        break;
      case 'resizable':
        ordersQuery = getPendingOrderQuery();
        ordersQuery.equalTo('resizable', true);
        break;
      case 'fully-shippable':
        ordersQuery = getPendingOrderQuery();
        ordersQuery.equalTo('fullyShippable', true);
        paginate = false;
        break;
      case 'partially-shippable':
        ordersQuery = getPendingOrderQuery();
        ordersQuery.equalTo('partiallyShippable', true);
        paginate = false;
        break;
      case 'cannot-ship':
        ordersQuery = getPendingOrderQuery();
        ordersQuery.equalTo('fullyShippable', false);
        ordersQuery.equalTo('partiallyShippable', false);
        break;
      default:
        ordersQuery.notEqualTo('status', 'Incomplete');
        break;
    }
    
  }
  
  ordersQuery = getOrderSort(ordersQuery, currentSort);
  ordersQuery.include('orderProducts');
  ordersQuery.include('orderProducts.variant');
  ordersQuery.include('orderProducts.variant.designer');
  ordersQuery.include('orderShipments');
  
  if (paginate) {
    ordersQuery.limit(ORDERS_PER_PAGE);
  } else {
    ordersQuery.limit(1000);
  }
  
  Parse.Cloud.httpRequest({
    method: 'post',
    url: process.env.SERVER_URL + '/functions/getOrderTabCounts',
    headers: {
      'X-Parse-Application-Id': process.env.APP_ID,
      'X-Parse-Master-Key': process.env.MASTER_KEY
    }
  }).then(function(response) {
    tabCounts = response.data.result;
    return ordersQuery.count();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(count) {
    totalOrders = count;
    totalPages = paginate ? Math.ceil(totalOrders / ORDERS_PER_PAGE) : 1;
    if (paginate) ordersQuery.skip((currentPage - 1) * ORDERS_PER_PAGE);
    
    // Only return orders that are shippable based on current inventory
    if (subpage == 'fully-shippable' || subpage == 'partially-shippable') {
      return getInventoryAwareShippableOrders(ordersQuery, currentSort);
    } else {
      return ordersQuery.find({useMasterKey:true});
    }
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(ordersResult) {
    if (ordersResult.shippable || ordersResult.partiallyShippable) {
      totalOrders = ordersResult.shippable.length + ordersResult.partiallyShippable.length + ordersResult.unshippable.length;
      switch (subpage) {
        case 'fully-shippable':
          tabCounts.fullyShippable = ordersResult.shippable.length;
          response.success({orders: ordersResult.shippable, totalPages: 1, totalOrders: totalOrders, tabCounts: tabCounts});
          break;
        case 'partially-shippable':
          tabCounts.partiallyShippable = ordersResult.partiallyShippable.length;
          response.success({orders: ordersResult.partiallyShippable, totalPages: 1, totalOrders: totalOrders, tabCounts: tabCounts});
          break;
        default:
          response.success({orders: ordersResult, totalPages: 1, totalOrders: totalOrders, tabCounts: tabCounts});
          break;
      }
      
    } else {
      response.success({orders: ordersResult, totalPages: totalPages, totalOrders: totalOrders, tabCounts: tabCounts});
    }
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("getOrderTabCounts", function(request, response) {  
  
  var tabs = {};
  var inventoryBasedUnshippable = 0;
  var inventoryBasedPartiallyShippable = 0;
  
  var awaitingFulfillmentQuery = getPendingOrderQuery();
  
  var resizableQuery = getPendingOrderQuery();
  resizableQuery.equalTo('fullyShippable', false);
  resizableQuery.equalTo('resizable', true); 
  
  var fullyShippableQuery = getPendingOrderQuery();
  fullyShippableQuery.equalTo('fullyShippable', true);  
  fullyShippableQuery.include('orderProducts');
  fullyShippableQuery.include('orderProducts.variant');
  
  var partiallyShippableQuery = getPendingOrderQuery();
  partiallyShippableQuery.equalTo('partiallyShippable', true);  
  partiallyShippableQuery.include('orderProducts');
  partiallyShippableQuery.include('orderProducts.variant');
  
  var cannotShipQuery = getPendingOrderQuery();
  cannotShipQuery.equalTo('fullyShippable', false);
  cannotShipQuery.equalTo('partiallyShippable', false); 
  
  var fulfilledQuery = new Parse.Query(Order);
  fulfilledQuery.equalTo('status', 'Shipped');
  
  awaitingFulfillmentQuery.count().then(function(count) {
    tabs.awaitingFulfillment = count;
    return resizableQuery.count();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(count) {
    tabs.resizable = count;
    return getInventoryAwareShippableOrders(fullyShippableQuery, 'fully-shippable');
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(ordersResult) {
    tabs.fullyShippable = ordersResult.shippable.length;
    if (ordersResult.partiallyShippable.length > 0) inventoryBasedPartiallyShippable += ordersResult.partiallyShippable.length;
    if (ordersResult.unshippable.length > 0) inventoryBasedUnshippable += ordersResult.unshippable.length;
    return getInventoryAwareShippableOrders(partiallyShippableQuery, 'partially-shippable');
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(ordersResult) {
    tabs.partiallyShippable = ordersResult.partiallyShippable.length;
    if (ordersResult.unshippable.length > 0) inventoryBasedUnshippable += ordersResult.unshippable.length;
    return cannotShipQuery.count();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(count) {
    tabs.cannotShip = count;
    if (inventoryBasedUnshippable > 0) tabs.cannotShip += inventoryBasedUnshippable;
    return fulfilledQuery.count();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(count) {
    tabs.fulfilled = count;
	  response.success(tabs);
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("loadOrder", function(request, response) {
  var bcOrder;
  var bcOrderId = request.params.orderId;
  var bcOrderShipments = [];
  var orderObj;
  var orderProducts = [];
  var orderShipments = [];
  var totalProductsAdded = 0;
  var totalShipmentsAdded = 0;
  var orderAdded = false;
  var hd;
  
  var orderRequest = '/orders/' + bcOrderId;
  logInfo(orderRequest);
  bigCommerce.get(orderRequest).then(function(res) {
    bcOrder = res;
    logInfo('\nOrder ' + bcOrderId + ' is ' + bcOrder.status + ' ------------------------');
    
    var orderQuery = new Parse.Query(Order);
    orderQuery.equalTo('orderId', parseInt(bcOrderId));
    return orderQuery.first();
    
  }).then(function(orderResult) {
//     hd = new memwatch.HeapDiff();
    
    if (orderResult) {
      logInfo('Order exists.');
      return createOrderObject(bcOrder, orderResult).save(null, {useMasterKey: true});
    } else {
      logInfo('Order is new.');
      orderAdded = true;
      return createOrderObject(bcOrder).save(null, {useMasterKey: true});
    }
    
  }).then(function(result) {
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//     hd = new memwatch.HeapDiff();
    
    orderObj = result;
    
    // Load order shipments
    var request = '/orders/' + bcOrderId + '/shipments?limit=' + BIGCOMMERCE_BATCH_SIZE;
    return bigCommerce.get(request);
    
  }).then(function(result) {
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//     hd = new memwatch.HeapDiff();
    
    if (result.length > 0) bcOrderShipments = result;
    
    // Load order products
    var request = '/orders/' + bcOrderId + '/products?limit=' + BIGCOMMERCE_BATCH_SIZE;
    return bigCommerce.get(request);
    
  }).then(function(bcOrderProducts) {
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
    
    var promise = Parse.Promise.as();
		_.each(bcOrderProducts, function(orderProduct) {
//   		hd = new memwatch.HeapDiff();
  		promise = promise.then(function() {
    		logInfo('Process orderProduct id: ' + orderProduct.id);
        var orderProductQuery = new Parse.Query(OrderProduct);
        orderProductQuery.equalTo('orderProductId', parseInt(orderProduct.id));
    		return orderProductQuery.first();
    		
  		}, function(error){
    		logError(error);
    		
  		}).then(function(orderProductResult) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        if (orderProductResult) {
          logInfo('OrderProduct ' + orderProductResult.get('orderProductId') + ' exists.');
          return createOrderProductObject(orderProduct, orderObj, orderProductResult);
        } else {
          logInfo('OrderProduct ' + orderProduct.id + ' is new.');
          totalProductsAdded++;
          return createOrderProductObject(orderProduct, orderObj);
        }
    		
  		}, function(error){
    		logError(error);
    		
  		}).then(function(orderProductObject) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
    		return getOrderProductVariant(orderProductObject);
    		
  		}, function(error){
    		logError(error);
    		
  		}).then(function(orderProductObject) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
    		return getOrderProductShippingAddress(orderProductObject);
    		
  		}, function(error){
    		logError(error);
    		
  		}).then(function(orderProductObject) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
    		// Set order product quantity shippped each time to update based on BC shipment changes
    		if (bcOrderShipments <= 0) {
      		orderProductObject.set('quantity_shipped', 0);
      		logInfo('OrderProduct quantity shipped: 0');
    		} else {
      		var totalShipped = 0;
      		_.each(bcOrderShipments, function(bcOrderShipment) {
        		_.each(bcOrderShipment.items, function(item) {
          		if (orderProduct.id == item.order_product_id) totalShipped += item.quantity;
        		});
      		});
      		orderProductObject.set('quantity_shipped', totalShipped);
      		logInfo('OrderProduct quantity shipped: ' + totalShipped);
    		}
    		
    		return orderProductObject.save(null, {useMasterKey: true});
    		
  		}, function(error){
    		logError(error);
    		
  		}).then(function(orderProductObject) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        logInfo('add OrderProduct ' + orderProductObject.get('orderProductId') + ' to orderProducts array');
    		orderProducts.push(orderProductObject);
    		return true;
    		
  		}, function(error){
    		logError(error);
    		
  		});
    });
    return promise;
    
  }).then(function(result) {
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//     hd = new memwatch.HeapDiff();
    
    logInfo('total orderProducts: ' + orderProducts.length);
    orderObj.set('orderProducts', orderProducts);
    
    // Check shippable and resize status of each OrderProduct
    if (orderProducts.length > 0) {
      return getOrderProductsStatus(orderProducts);
    } else {
      return true;
    }
    
  }).then(function(result) {
    if (result.length > 0) orderProducts = result;
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//     hd = new memwatch.HeapDiff();
    
    // Count the order's products shippable/resizable status
    logInfo('Count the orders products shippable/resizable status');
    var numShippable = 0;
    var numResizable = 0;
    _.each(orderProducts, function(orderProduct) {
      if (orderProduct.has('shippable') && orderProduct.get('shippable') == true) numShippable++;
      if (orderProduct.has('resizable') && orderProduct.get('resizable') == true) numResizable++;
    });
    
    // Set order shippable status
    if (numShippable == orderProducts.length) {
      logInfo('set as fully shippable');
      orderObj.set('fullyShippable', true);
      orderObj.set('partiallyShippable', false);
    } else if (numShippable > 0) {
      logInfo('set as partially shippable');
      orderObj.set('fullyShippable', false);
      orderObj.set('partiallyShippable', true);
    } else {
      logInfo('set as cannot ship');
      orderObj.set('fullyShippable', false);
      orderObj.set('partiallyShippable', false);
    }
    
    // Set order resizable status
    if (numResizable > 0) {
      logInfo('set as resizable');
      orderObj.set('resizable', true);
    } else {
      orderObj.set('resizable', false);
    }
    
    return true;
    
  }).then(function(result) {
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//     hd = new memwatch.HeapDiff();
    
    logInfo('Process order shipments');
    
    if (bcOrderShipments <= 0) {
      logInfo('No shipments found');
      if (bcOrder.status_id == 2) {
        // Set the Bigcommerce order status to 'Awaiting Fulfillment' (resets order when shipments are deleted)
        orderObj.set('status', 'Awaiting Fulfillment');
        orderObj.set('status_id', 11);
        var request = '/orders/' + bcOrderId;
        return bigCommerce.put(request, {status_id: 11}); 
      } else {
        return true;
      }
    } else {      
      logInfo(bcOrderShipments.length + ' shipments found');
    }
    
    var promise = Parse.Promise.as();
		_.each(bcOrderShipments, function(orderShipment) {
//   		hd = new memwatch.HeapDiff();
  		var orderShipmentObject;
  		promise = promise.then(function() {
    		logInfo('Process shipment id: ' + orderShipment.id);
        var orderShipmentQuery = new Parse.Query(OrderShipment);
        orderShipmentQuery.equalTo('shipmentId', parseInt(orderShipment.id));
    		return orderShipmentQuery.first()
    		
  		}).then(function(orderShipmentResult) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        
        if (orderShipmentResult) {
          logInfo('OrderShipment ' + orderShipmentResult.get('shipmentId') + ' exists.');
          return createOrderShipmentObject(orderShipment, null, orderShipmentResult);
        } else {
          logInfo('OrderShipment ' + orderShipment.id + ' is new.');
          totalShipmentsAdded++;
          return createOrderShipmentObject(orderShipment, null);
        }
    		
  		}).then(function(result) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        
    		orderShipmentObject = result;
//     		if (orderShipmentObject.has('packingSlip')) return orderShipmentObject;
    		return createOrderShipmentPackingSlip(orderObj, orderShipmentObject);
    		
  		}).then(function(result) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        
    		orderShipmentObject = result;
    		if (!orderShipmentObject.has('packingSlipUrl') || !orderShipmentObject.has('shippo_label_url')) return false;
    		return combinePdfs([orderShipmentObject.get('packingSlipUrl'), orderShipmentObject.get('shippo_label_url')]);
    		
  		}).then(function(result) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
            		
    		if (result) {
          orderShipmentObject.set('labelWithPackingSlip', result);
          orderShipmentObject.set('labelWithPackingSlipUrl', result.url());
    		}
    		return orderShipmentObject.save(null, {useMasterKey: true});
    		
  		}).then(function(result) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        
    		orderShipments.push(result);
    		return true;
  		});
    });
    return promise;
    
  }).then(function(result) {
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//     hd = new memwatch.HeapDiff();
    
    if (orderShipments.length > 0) {
      logInfo('set ' + orderShipments.length + ' shipments to the order');
      orderObj.set('orderShipments', orderShipments);
    } else {
      logInfo('set no shipments to the order');
      orderObj.unset('orderShipments');
    }
    logInfo('save order...');
    return orderObj.save(null, {useMasterKey: true});
    
  }).then(function() {
//     var diff = hd.end();
//     if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
    
    logInfo('order saved');
    response.success({added: orderAdded});
    
  }, function(error) {
    logError(error);
    response.error(error.message);
		
	});
});

Parse.Cloud.define("reloadOrder", function(request, response) {
  var orderId = parseInt(request.params.orderId);
  var updatedOrder;
  var bcOrder;
  var tabCounts;
  
  logInfo('reloadOrder ' + orderId);

  Parse.Cloud.httpRequest({
    method: 'post',
    url: process.env.SERVER_URL + '/functions/loadOrder',
    headers: {
      'X-Parse-Application-Id': process.env.APP_ID,
      'X-Parse-Master-Key': process.env.MASTER_KEY
    },
    params: {
      orderId: orderId
    }
  }).then(function(response) {
    logInfo('get order data');
    var ordersQuery = new Parse.Query(Order);
    ordersQuery.equalTo("orderId", orderId);
    ordersQuery.include('orderProducts');
    ordersQuery.include('orderProducts.variant');
    ordersQuery.include('orderProducts.variant.designer');
    ordersQuery.include('orderShipments');
    return ordersQuery.first();
    
  }).then(function(result) {
    updatedOrder = result;
    
    return Parse.Cloud.httpRequest({
      method: 'post',
      url: process.env.SERVER_URL + '/functions/getOrderTabCounts',
      headers: {
        'X-Parse-Application-Id': process.env.APP_ID,
        'X-Parse-Master-Key': process.env.MASTER_KEY
      }
    });
    
  }).then(function(httpResponse) {
    tabCounts = httpResponse.data.result;
    
    logInfo('order successfully reloaded');
	  response.success({updatedOrders: [updatedOrder], tabCounts: tabCounts});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("createShipments", function(request, response) {
  logInfo('createShipments --------------------------');
  
  var shipmentGroups = request.params.shipmentGroups ? request.params.shipmentGroups : null;
  var ordersToShip = request.params.ordersToShip ? request.params.ordersToShip : null;
  var carriers;
  var totalShipmentsAdded = 0;
  var updatedOrdersArray = [];
  var generatedFile;
  var newShipments = [];
  var shipmentGroupsFailed = [];
  var newOrderShipment = [];
  var errors = [];
    
  Parse.Cloud.httpRequest({
    method: 'get',
    url: 'https://api.goshippo.com/carrier_accounts/',
    headers: {
      'Authorization': 'ShippoToken ' + process.env.SHIPPO_API_TOKEN
    }
  }, function(error) {
    logError(error);
    
  }).then(function(httpResponse) {
    carriers = httpResponse.data.results;
    logInfo('total carriers ' + carriers.length);
    
    if (!shipmentGroups && ordersToShip) {
      logInfo('create shipment groups from order ids');
      shipmentGroups = [];
      
      var promise = Parse.Promise.as();
      _.each(ordersToShip, function(orderId) {
        promise = promise.then(function() {
          var orderQuery = new Parse.Query(Order);
          orderQuery.equalTo('orderId', parseInt(orderId));
          orderQuery.include('orderProducts');
          orderQuery.include('orderProducts.variant');
          orderQuery.include('orderShipments');
          return orderQuery.first();
          
        }).then(function(order) {
          var orderJSON = order.toJSON();
          var groups = createShipmentGroups(orderJSON, orderJSON.orderProducts, orderJSON.orderShipments);
          shipmentGroups = shipmentGroups.concat(groups.shippableGroups);
          return true;
          
        }, function(error) {
          logError(error);
          return false;
          
        });
      });
      return promise;
      
    } else {
      return true;
    }
    
  }).then(function(httpResponse) {
    logInfo(shipmentGroups.length + ' shipment groups');
    
    var promise = Parse.Promise.as();
    _.each(shipmentGroups, function(shipmentGroup) {
      
      var orderId = shipmentGroup.orderId;
      var orderAddressId = shipmentGroup.orderAddressId;
      var shippingAddress = shipmentGroup.orderProducts[0].shippingAddress;
      var billingAddress = shipmentGroup.orderBillingAddress;
      var customShipment = shipmentGroup.customShipment;
      var bcShipment;
      var shippoLabel;
      
      logInfo('Process order address: ' + orderAddressId);
      
      promise = promise.then(function() {

        // Load order shipments
        var request = '/orders/' + orderId + '/shipments?limit=' + BIGCOMMERCE_BATCH_SIZE;
        logInfo(request);
        return bigCommerce.get(request);
        
      }).then(function(bcOrderShipments) {
        
        if (bcOrderShipments.length > 0) {
          logInfo('There are ' + bcOrderShipments.length + ' bigcommerce shipments for order id ' + orderId);
        } else {
          logInfo('There are no bigcommerce shipments for order id ' + orderId);
        }

        var addressFrom  = {
          object_purpose: "PURCHASE",
          name: "Audry Rose",
          company: "",
          street1: "1112 Montana Ave.",
          street2: "#106",
          city: "Santa Monica",
          state: "CA",
          zip: "90403-3820",
          country: "US",
          phone: "+1 424 387 8000",
          email: "hello@loveaudryrose.com"
        };
        
        var name = shippingAddress.first_name + ' ' + shippingAddress.last_name;
        var email = shippingAddress.email ? shippingAddress.email : billingAddress.email;
        var addressTo = {
          object_purpose: "PURCHASE",
          name: name,
          street1: shippingAddress.street_1,
          city: shippingAddress.city,
          state: shippingAddress.state,
          zip: shippingAddress.zip,
          country: shippingAddress.country_iso2,
          email: email
        };
        if (shippingAddress.phone) addressTo.phone = shippingAddress.phone;
        if (shippingAddress.company) addressTo.company = shippingAddress.company;
        if (shippingAddress.street_2) addressTo.street2 = shippingAddress.street_2;
        
        var totalWeight = 0;
        var totalPrice = 0;
        _.map(shipmentGroup.orderProducts, function(p){
          totalPrice += parseFloat(p.total_inc_tax);
          totalWeight += parseFloat(p.weight * p.quantity); 
          return p;
        });
        
        var shipmentExtra = {};
        if (totalPrice >= 1000) {
          shipmentExtra.signature_confirmation = 'STANDARD';
          logInfo('shipment: signature required');
        } else {
          logInfo('shipment: no signature required');
        }
        
        // Set default parcel to USPS_SmallFlatRateBox
        var parcel = {
          length: "8.69",
          width: "5.44",
          height: "1.75",
          distance_unit: "in",
          weight: "3", // Use totalWeight.toString() if weight is correct in Bigcommerce
          mass_unit: "oz",
          template: "USPS_SmallFlatRateBox"
        }
        
        var serviceLevel;
        if (US_SHIPPING_ZONES.indexOf(parseInt(shippingAddress.shipping_zone_id)) >= 0) {
          if (totalPrice > 84) {
            serviceLevel = 'usps_priority';
          } else {
            serviceLevel = 'usps_first';
            // Overwrite parcel for USPS First Class
            parcel = {
              length: "3",
              width: "2",
              height: "1",
              distance_unit: "in",
              weight: "3",
              mass_unit: "oz"
            }
          }
        } else {
          serviceLevel = 'usps_first_class_package_international_service';
        }
        
        // Set the carrier to the default "usps"
        var carrier;
        _.map(carriers, function(c){
          if (c.carrier == 'usps') carrier = c;
          return c;
        });

        // Overwrite shipment options of customizations exist
        if (customShipment) {
          serviceLevel = customShipment.shippingServiceLevel;
          parcel = {
            length: customShipment.length,
            width: customShipment.width,
            height: customShipment.height,
            distance_unit: "in",
            weight: customShipment.weight,
            mass_unit: "oz"
          }
          if (customShipment.shippingParcel != 'custom') parcel.template = customShipment.shippingParcel;
          _.map(carriers, function(c){
            if (c.carrier == customShipment.shippingProvider) carrier = c;
            return c;
          });
        }
        
        // Create shipment object
        var shipment = {
          address_from: addressFrom,
          address_to: addressTo,
          parcel: parcel,
          object_purpose: "PURCHASE"
        };
        if (shipmentExtra.signature_confirmation) shipment.extra = shipmentExtra;
        
        console.log(shipment)
        console.log(carrier.object_id)
        console.log(serviceLevel)
        
        logInfo('do the shippo');
        
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: 'https://api.goshippo.com/transactions/',
          headers: {
            'Authorization': 'ShippoToken ' + process.env.SHIPPO_API_TOKEN,
            'Content-Type': 'application/json;charset=utf-8'
          },
          body: {
            shipment: shipment,
            carrier_account: carrier.object_id,
            servicelevel_token: serviceLevel
          }
        });
          
      }, function(error) {
        logError(error);
    
      }).then(function(httpResponse) {
        if (httpResponse.data.object_status == 'SUCCESS') {
          
          shippoLabel = httpResponse.data;
          logInfo('Shippo label status: ' + shippoLabel.object_status);
          
          // Create the Bigcommerce shipment
          var request = '/orders/' + orderId + '/shipments';
          var items = [];
          _.each(shipmentGroup.orderProducts, function(orderProduct) { 
            logInfo('Adding order product ' + orderProduct.orderProductId + ' to shipment');
            items.push({order_product_id: orderProduct.orderProductId, quantity: orderProduct.quantity});
          });
          var bcShipmentData = {
            tracking_number: shippoLabel.tracking_number,
            comments: "",
            order_address_id: orderAddressId,
            shipping_provider: "",
            items: items
          }
          return bigCommerce.post(request, bcShipmentData);
          
        } else {
          _.each(httpResponse.data.messages, function(message) { 
            
//             logError(message.text);
            var msg = 'Error with Order #' + orderId + ': ' + message.text;
            errors.push(msg);
          });
        }
        
      }, function(error) {
        logError('Error status: ' + error.status + ', Message: ' + error.text);
    
      }).then(function(bcShipmentResult) {
        //if (!isNew) return true; // Skip if Bigcommerce shipment exists
        if (bcShipmentResult) {
          bcShipment = bcShipmentResult;
          
          logInfo('Bigcommerce shipment ' + bcShipment.id + ' created');
          
          var orderShipmentQuery = new Parse.Query(OrderShipment);
          orderShipmentQuery.equalTo('shipmentId', parseInt(bcShipment.id));
      		return orderShipmentQuery.first();
    		
    		} else {
      		logError('No BC shipment created for order ' + orderId);
    		}
    		
  		}, function(error) {
        logError(error);
    
      }).then(function(orderShipmentResult) {
        if (orderShipmentResult) {
          logInfo('OrderShipment ' + orderShipmentResult.get('shipmentId') + ' exists.');
          return createOrderShipmentObject(bcShipment, shippoLabel, orderShipmentResult).save(null, {useMasterKey: true});
        } else if (bcShipment) {
          logInfo('OrderShipment is new.');
          totalShipmentsAdded++;
          return createOrderShipmentObject(bcShipment, shippoLabel).save(null, {useMasterKey: true});
        }
        
  		}, function(error) {
        logError(error);
    
      }).then(function(orderShipmentObject) {
        if (orderShipmentObject) {
          
          newOrderShipment = orderShipmentObject;
      		newShipments.push(newOrderShipment);
      		
          var orderQuery = new Parse.Query(Order);
          orderQuery.equalTo('orderId', parseInt(orderId));
          orderQuery.include('orderShipments');
      		return orderQuery.first();
    		} else {
      		shipmentGroupsFailed.push(shipmentGroup)
    		}
    		
  		}).then(function(orderResult) {
    		if (orderResult) {
      		orderResult.addUnique('orderShipments', newOrderShipment);
      		return orderResult.save(null, {useMasterKey: true});
    		}
    		
  		}).then(function(orderResult) {
    		logInfo('Order shipment saved to order');
    		return true;
    		
      }, function(error) {
        logError(error);
        return false;
        
      });
    });
    return promise;
    
  }).then(function() {
    
    // Create a list of all unique updated order ids
    var allOrderIds = [];
    _.each(newShipments, function(s) { 
      var index = allOrderIds.indexOf(s.get('order_id'));
      if (index < 0) allOrderIds.push(s.get('order_id'));
    });
    _.each(shipmentGroupsFailed, function(s) { 
      var index = allOrderIds.indexOf(s.orderId);
      if (index < 0) allOrderIds.push(s.orderId);
    });
    logInfo('orderIds to save: ' + allOrderIds.join(','));
    
    // Load each order into updatedOrdersArray with pointers
    var promise = Parse.Promise.as();
    _.each(allOrderIds, function(orderIdToLoad) {
      promise = promise.then(function() {
        var orderRequest = '/orders/' + orderIdToLoad;
        logInfo(orderRequest);
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadOrder',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            orderId: orderIdToLoad
          }
        });
          
      }).then(function(response) {
        logInfo('get order data');
        var ordersQuery = new Parse.Query(Order);
        ordersQuery.equalTo('orderId', parseInt(orderIdToLoad));
        ordersQuery.include('orderProducts');
        ordersQuery.include('orderProducts.variant');
        ordersQuery.include('orderProducts.variant.designer');
        ordersQuery.include('orderShipments');
        return ordersQuery.first();
      
      }).then(function(orderResult) {
        updatedOrdersArray.push(orderResult);
        return true;
        
      }, function(error) {
        logError(error);
      });
    });
    return promise;
    
  }).then(function() {
    
    // Combine all new pdfs into a single file
    var pdfsToCombine = [];
    _.each(newShipments, function(newShipment) {
      var newShipmentId = newShipment.get('shipmentId');
      _.each(updatedOrdersArray, function(updatedOrder) {
        var orderShipments = updatedOrder.get('orderShipments');
        _.each(orderShipments, function(orderShipment) {
          if (newShipmentId == orderShipment.get('shipmentId')) {
            if (orderShipment.has('labelWithPackingSlipUrl')) {
              logInfo('add to batch pdf: ' + orderShipment.get('labelWithPackingSlipUrl'));
              pdfsToCombine.push(orderShipment.get('labelWithPackingSlipUrl'));
            } else {
              var msg = 'Error: Order #' + orderShipment.get('order_id') + ' shipping label not added to combined print pdf file.';
              errors.push(msg);
            }
          }
        });
      });
    });
    return combinePdfs(pdfsToCombine);
    
  }).then(function(result) {
    if (result) {
      logInfo('batch pdf generated');
      generatedFile = result.url();
    } else {
      logError('no batch pdf generated');
      errors.push('Error creating combined shipping labels pdf.');
    }
    
    logInfo('Created ' + newShipments.length + ' shipments. ' + shipmentGroupsFailed.length + ' shipment groups failed.');
    response.success({updatedOrders: updatedOrdersArray, errors: errors, generatedFile: generatedFile});
    
  }, function(error) {
    logError(error);
    response.error(error.message);
  });

  
});

Parse.Cloud.define("batchCreateShipments", function(request, response) {
  var ordersToShip = request.params.ordersToShip;
  var updatedOrders = [];
  var allShipmentGroups = [];
  var tabCounts;
  var generatedFile;
  
  logInfo('\nbatchCreateShipments -----------------------------');
  
  // Create shipment groups
  bigCommerce.get('/orders/count', function(err, data, response){
    return data.count;
  
  }).then(function(count) {
    
    return Parse.Cloud.httpRequest({
      method: 'post',
      url: process.env.SERVER_URL + '/functions/createShipments',
      headers: {
        'X-Parse-Application-Id': process.env.APP_ID,
        'X-Parse-Master-Key': process.env.MASTER_KEY
      },
      params: {
        ordersToShip: ordersToShip
      }
    });
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(httpResponse) {
    updatedOrders = httpResponse.data.result.updatedOrders;
    errors = httpResponse.data.result.errors;
    generatedFile = httpResponse.data.result.generatedFile;
    
    return Parse.Cloud.httpRequest({
      method: 'post',
      url: process.env.SERVER_URL + '/functions/getOrderTabCounts',
      headers: {
        'X-Parse-Application-Id': process.env.APP_ID,
        'X-Parse-Master-Key': process.env.MASTER_KEY
      }
    });
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(httpResponse) {
    tabCounts = httpResponse.data.result;
    
    logInfo('order successfully reloaded');
	  response.success({updatedOrders: updatedOrders, tabCounts: tabCounts, errors: errors, generatedFile: generatedFile});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("batchPrintShipments", function(request, response) {
  var ordersToPrint = request.params.ordersToPrint;
  var generatedFile;
  var errors = [];
  
  var ordersQuery = new Parse.Query(Order);
  ordersQuery.containedIn('orderId', ordersToPrint);
  ordersQuery.include('orderShipments');
  
  ordersQuery.find().then(function(orders) {
    
    // Combine all new pdfs into a single file
    var pdfsToCombine = [];
    _.each(orders, function(order) {
      var orderShipments = order.get('orderShipments');
      _.each(orderShipments, function(orderShipment) {
        if (orderShipment.has('labelWithPackingSlipUrl')) {
          logInfo('add to batch pdf: ' + orderShipment.get('labelWithPackingSlipUrl'));
          pdfsToCombine.push(orderShipment.get('labelWithPackingSlipUrl'));
        } else {
          var msg = 'Error: Order #' + orderShipment.get('order_id') + ' shipping label not added to combined print file.';
          errors.push(msg);
        }
      });
    });
    return combinePdfs(pdfsToCombine);
    
  }, function(error) {
	  logError(error);
	  errors.push(error.message);
	  
  }).then(function(result) {
    if (result) {
      logInfo('batch pdf generated');
      generatedFile = result.url();
    } else {
      logError('no batch pdf generated');
      errors.push('Error creating combined shipping labels pdf.');
    }
	  response.success({generatedFile: generatedFile, errors: errors});
	  
  }, function(error) {
	  logError(error);
	  response.error(error);
	  
  });
});

/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Order", function(request, response) {
  var order = request.object;

  var toLowerCase = function(w) { return w.toLowerCase(); };
  
  var processSearchTerms = function(searchTerms) {
    searchTerms = _.map(searchTerms, toLowerCase);
    var stopWords = ["the", "in", "and", "with"];
    searchTerms = _.filter(searchTerms, function(w) { return !_.contains(stopWords, w); });
    return searchTerms;
  }
  
  var searchTerms = [];
  // Add customer name to search terms
  var billingAddress = order.get('billing_address');
  searchTerms.push(toLowerCase(billingAddress.first_name));
  searchTerms.push(toLowerCase(billingAddress.last_name));
  searchTerms.push(toLowerCase(billingAddress.email));
  searchTerms.push(order.get('orderId').toString());
  
  // Process properties based on OrderProducts - needs to use promises
  if (order.has('orderProducts')) {
    var orderProducts = order.get('orderProducts');
    var orderProductIds = [];
    Parse.Object.fetchAll(orderProducts).then(function(orderProductObjects) {
      _.each(orderProductObjects, function(orderProduct) {
        // Add parent product id to array for faster order searching
        if (orderProduct.has('product_id')) orderProductIds.push(orderProduct.get('product_id'));
        // Add the product names as search terms
        var nameTerms = orderProduct.get('name').split(' ');
        nameTerms = _.map(nameTerms, toLowerCase);
        searchTerms = searchTerms.concat(nameTerms);
      });
      return searchTerms;
    }).then(function() {
      // Save the array of product ids
      order.set("productIds", orderProductIds);
      // Add the product names as search terms
      searchTerms = processSearchTerms(searchTerms);
      order.set("search_terms", searchTerms);
      response.success();
    });
  } else {
    // Add the product names as search terms
    searchTerms = processSearchTerms(searchTerms);
    order.set("search_terms", searchTerms);
    response.success();
  }
  
});

Parse.Cloud.beforeSave("OrderShipment", function(request, response) {
  var orderShipment = request.object;
  
  // Match the OrderShipment's items to a ProductVariant and decrement the inventoryLevel by quantity shipped
  if (!orderShipment.has('inventoryUpdated') || orderShipment.get('inventoryUpdated') == false) {
    var items = orderShipment.get('items');
    logInfo('order products need inventory updated for ' + items.length + ' items');
    var totalItemsProcessed = 0;
    var variantsToSave = [];
    _.each(items, function(item) {
      logInfo('get product ' + item.order_product_id);
      var orderProductQuery = new Parse.Query(OrderProduct);
      orderProductQuery.equalTo('orderProductId', parseInt(item.order_product_id));
      orderProductQuery.include('variant');
      orderProductQuery.first().then(function(result) {
        if (result) {
          logInfo('order product ' + result.get('orderProductId') + ' exists');
          if (result.has('variant')) {
            var variant = result.get('variant');
            logInfo('matches variant ' + variant.get('variantId'));
            var totalToSubtract = parseInt(item.quantity) * -1;
            if (!variant.has('inventoryLevel')) variant.set('inventoryLevel', 0);
            variant.increment('inventoryLevel', totalToSubtract);
            variantsToSave.push(variant);
          } else {
            logInfo('no variant for order product ' + result.get('orderProductId'));
          }

        } else {
          logInfo('order product does not exist ' + item.order_product_id);
        }
        totalItemsProcessed++;
        if (totalItemsProcessed == items.length) {
          logInfo('all items processed');
          if (variantsToSave.length > 0) {
            logInfo('save inventory for all variants');
            orderShipment.set('inventoryUpdated', true);
            return Parse.Object.saveAll(variantsToSave, {useMasterKey: true});
          } else {
            logInfo('no variants to save');
            return true;
          }
        } else {
          return true;
        }
        
      }).then(function() {
        if (totalItemsProcessed == items.length) {
          logInfo('inventory saved for all variants');
          response.success();
        } else {
          return true;
        }
      });
    });
  } else {
    logInfo('order products do not need inventory updated');
    response.success();
  }

});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var getOrderSort = function(ordersQuery, currentSort) {
  switch (currentSort) {
    case 'date-added-desc':
      ordersQuery.descending("date_created");
      break;
    case 'date-added-asc':
      ordersQuery.ascending("date_created");
      break;
    case 'date-shipped-desc':
      ordersQuery.descending("date_shipped");
      break;
    case 'date-shipped-asc':
      ordersQuery.ascending("date_shipped");
      break;
    case 'total-desc':
      ordersQuery.descending("total_inc_tax");
      break;
    case 'total-asc':
      ordersQuery.ascending("total_inc_tax");
      break;
    default:
      ordersQuery.descending("date_created");
      break;
  }
  return ordersQuery;
}

var getPendingOrderQuery = function() {
  var afQuery = new Parse.Query(Order);
  afQuery.equalTo('status', 'Awaiting Fulfillment');
  var psQuery = new Parse.Query(Order);
  psQuery.equalTo('status', 'Partially Shipped');
  return Parse.Query.or(afQuery, psQuery);
}

var getInventoryAwareShippableOrders = function(ordersQuery, currentSort) {
  var ordersSorted = ordersQuery;
  ordersSorted.ascending("date_created");
  var variantsOrderedCount = [];
  var shippableOrderProducts = [];
  var unshippableOrderProducts = [];
  var shippableOrders = [];
  var partiallyShippableOrders = [];
  var unshippableOrders = [];
  
  var promise = Parse.Promise.as();
  
  promise = promise.then(function() {
    return ordersSorted.find();
    
  }).then(function(ordersResult) {
    _.each(ordersResult, function(order) {
//       logInfo('getInventoryAwareShippableOrders order: ' + order.get('orderId'));
      var orderProducts = order.get('orderProducts');
      _.each(orderProducts, function(orderProduct) {
        var variant = orderProduct.get('variant');
        if (variant) {
          var counted = false;
          for (var i = 0; i < variantsOrderedCount.length; i++) {
            var item = variantsOrderedCount[i];
            if (variant && item.variantId == variant.id) {
              var totalOrdered = item.totalOrdered + orderProduct.get('quantity');
              if (totalOrdered <= variant.get('inventoryLevel')) {
  //               logInfo('variant ' + variant.id + ' is shippable with ' + totalOrdered + ' total ordered');
                variantsOrderedCount[i].totalOrdered = totalOrdered;
                shippableOrderProducts.push(orderProduct);
              } else {
  //               logInfo('variant ' + variant.id + ' is not shippable with ' + totalOrdered + ' total ordered');
                unshippableOrderProducts.push(orderProduct);
              }
              counted = true;
            }
          };
          if (!counted && orderProduct.get('quantity') <= variant.get('inventoryLevel')) {
  //           logInfo('new variant ' + variant.id + ' is shippable with ' + orderProduct.get('quantity') + ' total ordered');
            variantsOrderedCount.push({variantId: variant.id, totalOrdered: orderProduct.get('quantity')});
            shippableOrderProducts.push(orderProduct);
          } else if (!counted && orderProduct.get('quantity') > variant.get('inventoryLevel')) {
  //           logInfo('new variant ' + variant.id + ' is not shippable with ' + orderProduct.get('quantity') + ' total ordered');
            unshippableOrderProducts.push(orderProduct);
          }
        } else {
          logInfo('order product does not have a variant');
        }
      });
    });
    logInfo('shippableOrderProducts:' + shippableOrderProducts.length + ', unshippableOrderProducts:' + unshippableOrderProducts.length);
    ordersQuery = getOrderSort(ordersQuery, currentSort);
    return ordersQuery.find();
  
  }).then(function(ordersResult) {
    _.each(ordersResult, function(order) {
      var orderProducts = order.get('orderProducts');
      var totalShippableOrderProducts = 0;
      _.each(orderProducts, function(orderProduct) {
        _.each(shippableOrderProducts, function(shippableOrderProduct) {
          if (orderProduct.id == shippableOrderProduct.id) totalShippableOrderProducts++;
        });
      });
      if (orderProducts.length == totalShippableOrderProducts) {
//         logInfo('order is shippable');
        shippableOrders.push(order);
      } else if (totalShippableOrderProducts > 0) {
//         logInfo('order is partially shippable');
        partiallyShippableOrders.push(order);
      } else {
//         logInfo('order is unshippable');
        unshippableOrders.push(order);
      }
    });
    return {shippable: shippableOrders, partiallyShippable: partiallyShippableOrders, unshippable: unshippableOrders};
  });
      
  return promise;
}

var createOrderObject = function(orderData, currentOrder) {
  var order = (currentOrder) ? currentOrder : new Order();
  
  order.set('orderId', parseInt(orderData.id));
  order.set('date_created', moment.utc(orderData.date_created, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  order.set('date_modified', moment.utc(orderData.date_modified, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  order.set('billing_address', orderData.billing_address);
  order.set('customer_id', parseInt(orderData.customer_id));
  if (orderData.date_shipped) order.set('date_shipped',  moment.utc(orderData.date_shipped, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  order.set('status_id', parseInt(orderData.status_id));
  order.set('status', orderData.status);
  order.set('subtotal_ex_tax', parseFloat(orderData.subtotal_ex_tax));
  order.set('subtotal_inc_tax', parseFloat(orderData.subtotal_inc_tax));
  order.set('subtotal_tax', parseFloat(orderData.subtotal_tax));
  order.set('base_shipping_cost', parseFloat(orderData.base_shipping_cost));
  order.set('shipping_cost_ex_tax', parseFloat(orderData.shipping_cost_ex_tax));
  order.set('shipping_cost_inc_tax', parseFloat(orderData.shipping_cost_inc_tax));
  order.set('shipping_cost_tax', parseFloat(orderData.shipping_cost_tax));
  order.set('shipping_cost_tax_class_id', parseInt(orderData.shipping_cost_tax_class_id));
  order.set('base_handling_cost', parseFloat(orderData.base_handling_cost));
  order.set('handling_cost_ex_tax', parseFloat(orderData.handling_cost_ex_tax));
  order.set('handling_cost_inc_tax', parseFloat(orderData.handling_cost_inc_tax));
  order.set('handling_cost_tax', parseFloat(orderData.handling_cost_tax));
  order.set('handling_cost_tax_class_id', parseInt(orderData.handling_cost_tax_class_id));
  order.set('base_wrapping_cost', parseFloat(orderData.base_wrapping_cost));
  order.set('wrapping_cost_ex_tax', parseFloat(orderData.wrapping_cost_ex_tax));
  order.set('wrapping_cost_inc_tax', parseFloat(orderData.wrapping_cost_inc_tax));
  order.set('wrapping_cost_tax', parseFloat(orderData.wrapping_cost_tax));
  order.set('wrapping_cost_tax_class_id', parseInt(orderData.wrapping_cost_tax_class_id));
  order.set('total_ex_tax', parseFloat(orderData.total_ex_tax));
  order.set('total_inc_tax', parseFloat(orderData.total_inc_tax));
  order.set('total_tax', parseFloat(orderData.total_tax));
  order.set('items_total', parseInt(orderData.items_total));
  order.set('items_shipped', parseInt(orderData.items_shipped));
  order.set('payment_method', orderData.payment_method);
  order.set('payment_provider_id', orderData.payment_provider_id);
  order.set('payment_status', orderData.payment_status);
  order.set('refunded_amount', parseFloat(orderData.refunded_amount));
  order.set('store_credit_amount', parseFloat(orderData.store_credit_amount));
  order.set('gift_certificate_amount', parseFloat(orderData.gift_certificate_amount));
  order.set('currency_id', parseInt(orderData.currency_id));
  order.set('currency_code', orderData.currency_code);
  order.set('currency_exchange_rate', parseFloat(orderData.currency_exchange_rate));
  order.set('default_currency_id', parseInt(orderData.default_currency_id));
  order.set('default_currency_code', orderData.default_currency_code);
  order.set('staff_notes', orderData.staff_notes);
  order.set('customer_message', orderData.customer_message);
  order.set('discount_amount', parseFloat(orderData.discount_amount));
  order.set('coupon_discount', parseFloat(orderData.coupon_discount));
  order.set('shipping_address_count', parseInt(orderData.shipping_address_count));
  order.set('is_deleted', orderData.is_deleted == 'true');
  
  return order;
}

var createOrderProductObject = function(orderProductData, order, currentOrderProduct) {
  var orderProduct = (currentOrderProduct) ? currentOrderProduct : new OrderProduct();
  
  if (orderProductData.id) orderProduct.set('orderProductId', parseInt(orderProductData.id));
  if (orderProductData.order_id) orderProduct.set('order_id', parseInt(orderProductData.order_id));
  if (orderProductData.product_id) orderProduct.set('product_id', parseInt(orderProductData.product_id));
  if (orderProductData.order_address_id) orderProduct.set('order_address_id', parseInt(orderProductData.order_address_id));
  if (orderProductData.name) orderProduct.set('name', orderProductData.name);
  if (orderProductData.sku) orderProduct.set('sku', orderProductData.sku);
  if (orderProductData.type) orderProduct.set('type', orderProductData.type);
  if (orderProductData.base_price) orderProduct.set('base_price', parseFloat(orderProductData.base_price));
  if (orderProductData.price_ex_tax) orderProduct.set('price_ex_tax', parseFloat(orderProductData.price_ex_tax));
  if (orderProductData.price_inc_tax) orderProduct.set('price_inc_tax', parseFloat(orderProductData.price_inc_tax));
  if (orderProductData.price_tax) orderProduct.set('price_tax', parseFloat(orderProductData.price_tax));
  if (orderProductData.base_total) orderProduct.set('base_total', parseFloat(orderProductData.base_total));
  if (orderProductData.total_ex_tax) orderProduct.set('total_ex_tax', parseFloat(orderProductData.total_ex_tax));
  if (orderProductData.total_inc_tax) orderProduct.set('total_inc_tax', parseFloat(orderProductData.total_inc_tax));
  if (orderProductData.total_tax) orderProduct.set('total_tax', parseFloat(orderProductData.total_tax));
  if (orderProductData.weight) orderProduct.set('weight', parseFloat(orderProductData.weight));
  orderProduct.set('quantity', parseInt(orderProductData.quantity));
  if (orderProductData.base_cost_price) orderProduct.set('base_cost_price', parseFloat(orderProductData.base_cost_price));
  if (orderProductData.cost_price_inc_tax) orderProduct.set('cost_price_inc_tax', parseFloat(orderProductData.cost_price_inc_tax));
  if (orderProductData.cost_price_ex_tax) orderProduct.set('cost_price_ex_tax', parseFloat(orderProductData.cost_price_ex_tax));
  if (orderProductData.cost_price_tax) orderProduct.set('cost_price_tax', parseFloat(orderProductData.cost_price_tax));
  if (orderProductData.is_refunded != undefined) orderProduct.set('is_refunded', orderProductData.is_refunded);
  orderProduct.set('quantity_refunded', parseInt(orderProductData.quantity_refunded));
  if (orderProductData.refund_amount) orderProduct.set('refund_amount', parseFloat(orderProductData.refund_amount));
  if (orderProductData.return_id) orderProduct.set('return_id', parseInt(orderProductData.return_id));
  if (orderProductData.wrapping_name) orderProduct.set('wrapping_name', orderProductData.wrapping_name);
  if (orderProductData.base_wrapping_cost) orderProduct.set('base_wrapping_cost', parseFloat(orderProductData.base_wrapping_cost));
  if (orderProductData.wrapping_cost_ex_tax) orderProduct.set('wrapping_cost_ex_tax', parseFloat(orderProductData.wrapping_cost_ex_tax));
  if (orderProductData.wrapping_cost_inc_tax) orderProduct.set('wrapping_cost_inc_tax', parseFloat(orderProductData.wrapping_cost_inc_tax));
  if (orderProductData.wrapping_cost_tax) orderProduct.set('wrapping_cost_tax', parseFloat(orderProductData.wrapping_cost_tax));
  if (orderProductData.wrapping_message) orderProduct.set('wrapping_message', orderProductData.wrapping_message);
  if (orderProductData.fixed_shipping_cost) orderProduct.set('fixed_shipping_cost', parseFloat(orderProductData.fixed_shipping_cost));
  if (orderProductData.ebay_item_id) orderProduct.set('ebay_item_id', orderProductData.ebay_item_id);
  if (orderProductData.ebay_transaction_id) orderProduct.set('ebay_transaction_id', orderProductData.ebay_transaction_id);
  if (orderProductData.option_set_id) orderProduct.set('option_set_id', parseInt(orderProductData.option_set_id));
  if (orderProductData.parent_order_product_id) orderProduct.set('parent_order_product_id', parseInt(orderProductData.parent_order_product_id));
  if (orderProductData.is_bundled_product != undefined) orderProduct.set('is_bundled_product', orderProductData.is_bundled_product);
  if (orderProductData.bin_picking_number) orderProduct.set('bin_picking_number', orderProductData.bin_picking_number);
  if (orderProductData.external_id) orderProduct.set('external_id', orderProductData.external_id);
  if (orderProductData.applied_discounts) orderProduct.set('applied_discounts', orderProductData.applied_discounts);
  if (orderProductData.product_options) orderProduct.set('product_options', orderProductData.product_options);
  if (orderProductData.configurable_fields) orderProduct.set('configurable_fields', orderProductData.configurable_fields);
  
  return orderProduct;
}

var getOrderProductVariant = function(orderProduct) {
  
  var promise = Parse.Promise.as();
  
  // Match the OrderProduct to a ProductVariant and save as a pointer
  var productQuery = new Parse.Query(Product);
  productQuery.equalTo('productId', orderProduct.get('product_id'));
  productQuery.include('variants');
  
  promise = promise.then(function() {
    return productQuery.first();
    
  }).then(function(result) {
    if (result && result.has('variants')) {
      var variants = result.get('variants')
      if (variants.length > 0) {
        var variantMatch = getOrderProductVariantMatch(orderProduct, variants);
        if (variantMatch) orderProduct.set('variant', variantMatch);
      } else {
        var msg = 'Variant not found for product ' + orderProduct.get('product_id');
        logInfo(msg);
      }
    } else if (result) {
      logInfo('product ordered has no variants');
      return false;
    } else {
      logInfo('custom product ordered without variants');
      orderProduct.set('isCustom', true);
    }
    return orderProduct;
  });
  
  return promise;
}

var getOrderProductShippingAddress = function(orderProduct) {
  
  var promise = Parse.Promise.as();
  
  // Get the OrderProduct's shipping address from Bigcommerce   
  promise = promise.then(function() {
    var request = '/orders/' + orderProduct.get('order_id') + '/shipping_addresses/' + orderProduct.get('order_address_id');
    return bigCommerce.get(request);
    
  }).then(function(address) {
    logInfo('adding OrderProduct shipping address: ' + address.id);
    var shippingAddress = address;
    orderProduct.set('shippingAddress', shippingAddress);
    return orderProduct;
  }, function(error) {
    logError(error);
    return false;
  });
  
  return promise;
}

var getOrderProductVariantMatch = function(orderProduct, variants) {
  logInfo(variants.length + ' variants found for product ' + orderProduct.get('product_id'));
  var productOptions = orderProduct.get('product_options');
  var totalProductOptions = productOptions.length;
  logInfo('product has ' + totalProductOptions + ' options');
  
  if (variants.length == 1 && productOptions.length == 0) {
    logInfo('Matched ' + variants.length + ' variant');
    return variants[0];
    
  } else {

    var matchingVariants = [];
    // Check if any variants are eligible for resize
    _.each(variants, function(variant) {
      var variantOptions = variant.has('variantOptions') ? variant.get('variantOptions') : [];
      
      var matchesProductOptions = false;
      var totalOptionsToCheck = productOptions.length;
      var optionsChecked = 0;
      var optionMatches = 0;
      
      _.each(productOptions, function(productOption) {
        optionsChecked++;
        _.each(variantOptions, function(variantOption) {
          if (productOption.option_id == variantOption.option_id && productOption.value == variantOption.option_value_id) {
            optionMatches++;
          }
        });
        if (CUSTOM_PRODUCT_OPTIONS.indexOf(productOption.option_id) >= 0) {
          // Option is customizable, force it to match
          optionMatches++;
        } 
        if (optionsChecked == totalOptionsToCheck && optionMatches == totalOptionsToCheck) {
          // All options checked
          matchesProductOptions = true;
        }
      });
      
      if (matchesProductOptions) matchingVariants.push(variant);
    });
    logInfo(matchingVariants.length + ' variants match');

    if (matchingVariants.length > 0) { // TODO: make this match only 1 variant, if multiple, figure which is correct
      matchedVariant = matchingVariants[0];
      logInfo('Matched variant ' + matchedVariant.get('variantId'));
      return matchedVariant;
    } else {
      logInfo('Matched ' + matchingVariants.length + ' variants');
      return null;
    }
  }

}

var getOrderProductsStatus = function(orderProducts) {
  logInfo('- getOrderProductsStatus -')
  
  var savedOrderProducts = [];
  var count = 0;
  
  var promise = Parse.Promise.as();
  
  _.each(orderProducts, function(orderProduct) {
    
    promise = promise.then(function() {
      
    	logInfo('\nGet status for OrderProduct ' + orderProduct.get('orderProductId'));
    	
    	var orderProductVariant = orderProduct.has('variant') ? orderProduct.get('variant') : null;
      // Determine if product is in resizable class
      var isResizeProductType = (orderProductVariant && orderProductVariant.has('size_value')) ? true : false;
    	
    	if (orderProduct.has('quantity_shipped') && orderProduct.get('quantity_shipped') >= orderProduct.get('quantity')) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' has already shipped');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	return orderProduct;

    	} else if (orderProduct.has('isCustom') && orderProduct.get('isCustom') == true) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' is custom');
      	// TODO: do something here with custom order products
      	return orderProduct;
      	
    	} else if (!orderProductVariant) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' does not have any variants');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
        return orderProduct;
      	
    	} else if (orderProductVariant.get('inventoryLevel') >= orderProduct.get('quantity')) {
      	// Has inventory, save it and exit
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' is shippable');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', true);
        return orderProduct;
      	
    	} else if (!isResizeProductType) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' is not a resizable product');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
        return orderProduct;
      	
    	} else {
      	// No inventory and OrderProduct has sizes, check if resizable
      	orderProduct.set('shippable', false);
      	return getOrderProductResizable(orderProduct);
      		
      }

  	}).then(function(orderProductEdited) {
    	return orderProductEdited.save(null, {useMasterKey:true});
    	
  	}).then(function(orderProductResult) {
    	savedOrderProducts.push(orderProductResult);
    	count++;
    	if (count == orderProducts.length) return savedOrderProducts;
    	
  	}, function(error) {
    	logError(error);
  	});
	});
  return promise;
}

var getOrderProductResizable = function(orderProduct) {
  var orderProductVariant = orderProduct.get('variant');
  
	var promise = Parse.Promise.as();
	promise = promise.then(function() {
		var productQuery = new Parse.Query(Product);
		productQuery.equalTo('productId', orderProduct.get('product_id'));
		productQuery.include('variants');
		return productQuery.first();
		
	}).then(function(result) {
    if (result) {
      logInfo('Set product status for OrderProduct ' + orderProduct.get('orderProductId'));
      var orderVariantSize = parseFloat(orderProductVariant.get('size_value'));
      var orderProductVariantOptions = orderProductVariant.has('variantOptions') ? orderProductVariant.get('variantOptions') : [];
      var variants = result.get('variants');
      var eligibleVariants = [];
      // Check if any variants are eligible for resize
      _.each(variants, function(variant) {
        // Check if variant is in stock
        if (variant.has('inventoryLevel') && variant.get('inventoryLevel') > 0) {
          var variantSize = parseFloat(variant.get('size_value'));
          var sizeDifference = Math.abs(orderVariantSize - variantSize);
          
          var matchesProductOptions = false;
          var totalOptionsToCheck = orderProductVariantOptions.length;
          var optionsChecked = 0;
          var optionMatches = 0;
          _.each(orderProductVariantOptions, function(orderProductVariantOption) {
            optionsChecked++;
            // Ignore the size options
            if (SIZE_PRODUCT_OPTIONS.indexOf(orderProductVariantOption.option_id) < 0) {
              var variantOptions = variant.has('variantOptions') ? variant.get('variantOptions') : [];
              _.each(variantOptions, function(variantOption) {
                if (orderProductVariantOption.option_id == variantOption.option_id && orderProductVariantOption.option_value_id == variantOption.option_value_id) {
                  logInfo('\nVariant size difference: ' + sizeDifference);
                  logInfo('Variant inventory: ' + variant.get('inventoryLevel')); 
                  logInfo(orderProductVariantOption.display_name + ': ' + orderProductVariantOption.value + ' ' + variantOption.value);
                  optionMatches++;
                }
              });
            }
            
            if (optionsChecked == totalOptionsToCheck && optionMatches == (totalOptionsToCheck - 1)) {
              // All options checked
              matchesProductOptions = true;
            }
          });
          
          if (matchesProductOptions) eligibleVariants.push(variant);
        }
      });
      logInfo(eligibleVariants.length + ' variants could be resized');
      if (eligibleVariants.length > 0) {
        orderProduct.set('resizable', true);
      } else {
        orderProduct.set('resizable', false);
      }
      return orderProduct;
    } else {
      var msg = 'Cannot determine product resizable for OrderProduct ' + orderProduct.get('orderProductId');
      logInfo(msg);
      orderProduct.set('resizable', false);
      return orderProduct;
    }
	});
	return promise;
}

var createOrderShipmentObject = function(shipmentData, shippoLabel, currentShipment) {
  var shipment = (currentShipment) ? currentShipment : new OrderShipment();
  
  shipment.set('shipmentId', parseInt(shipmentData.id));
  shipment.set('order_id', parseInt(shipmentData.order_id));
  shipment.set('customer_id', parseInt(shipmentData.customer_id));
  shipment.set('order_address_id', parseInt(shipmentData.order_address_id));
  shipment.set('date_created', moment.utc(shipmentData.date_created, 'ddd, DD MMM YYYY HH:mm:ss Z').toDate());
  shipment.set('tracking_number', shipmentData.tracking_number);
  shipment.set('shipping_method', shipmentData.shipping_method);
  shipment.set('shipping_provider', shipmentData.shipping_provider);
  shipment.set('tracking_carrier', shipmentData.tracking_carrier);
  shipment.set('comments', shipmentData.comments);
  shipment.set('billing_address', shipmentData.billing_address);
  shipment.set('shipping_address', shipmentData.shipping_address);
  
  var parseItemObject = function(item) {
    var obj = {};
    obj.order_product_id = parseInt(item.order_product_id);
    obj.product_id = parseInt(item.product_id);
    obj.quantity = parseInt(item.quantity);
    return item;
  };
  var items = _.map(shipmentData.items, parseItemObject);
  shipment.set('items', items);
  
  if (shippoLabel) {
    shipment.set('shippo_object_state', shippoLabel.object_state);
    shipment.set('shippo_object_status', shippoLabel.object_status);
    shipment.set('shippo_object_created', moment.utc(shippoLabel.object_created, moment.ISO_8601).toDate());
    shipment.set('shippo_object_updated', moment.utc(shippoLabel.object_updated, moment.ISO_8601).toDate());
    shipment.set('shippo_object_id', shippoLabel.object_id);
    shipment.set('shippo_test', shippoLabel.test);
    shipment.set('shippo_rate', shippoLabel.rate);
    shipment.set('shippo_pickup_date', shippoLabel.pickup_date);
    shipment.set('shippo_notification_email_from', shippoLabel.notification_email_from);
    shipment.set('shippo_notification_email_to', shippoLabel.notification_email_to);
    shipment.set('shippo_notification_email_other', shippoLabel.notification_email_other);
    shipment.set('shippo_tracking_number', shippoLabel.tracking_number);
    shipment.set('shippo_tracking_status', shippoLabel.tracking_status);
    shipment.set('shippo_tracking_history', shippoLabel.tracking_history);
    shipment.set('shippo_tracking_url_provider', shippoLabel.tracking_url_provider);
    shipment.set('shippo_label_url', shippoLabel.label_url);
    shipment.set('shippo_commercial_invoice_url', shippoLabel.commercial_invoice_url);
    shipment.set('shippo_messages', shippoLabel.messages);
    shipment.set('shippo_customs_note', shippoLabel.customs_note);
    shipment.set('shippo_submission_note', shippoLabel.submission_note);
    shipment.set('shippo_order', shippoLabel.order);
    shipment.set('shippo_metadata', shippoLabel.metadata);
    shipment.set('shippo_parcel', shippoLabel.parcel);
  }
  
  return shipment;
}

var createShipmentGroups = function(order, orderProducts, shippedShipments) {
	// Create an array of shipments
	var shippedGroups = [];
	var shippableGroups = [];
	var unshippableGroups = [];
	
	if (orderProducts) {
		orderProducts.map(function(orderProduct, i) {
  		console.log('\nop:' + orderProduct.orderProductId + ' oa:' + orderProduct.order_address_id);
  		
  		// Check if product is in a shipment
  		var isShipped = false;
  		var shippedShipmentId;
  		var shipment;
  		if (shippedShipments) {
    		shippedShipments.map(function(shippedShipment, j) {
      		shippedShipment.items.map(function(item, k) {
        		if (orderProduct.order_address_id === shippedShipment.order_address_id && orderProduct.orderProductId === item.order_product_id) {
          		isShipped = true;
          		shippedShipmentId = shippedShipment.shipmentId;
          		shipment = shippedShipment;
        		}
        		return item;
      		});
      		return shippedShipments;
    		});
  		}
      var group = {
        orderId: orderProduct.order_id, 
        orderAddressId: orderProduct.order_address_id, 
        orderBillingAddress: order.billing_address,
        shippedShipmentId: shippedShipmentId, 
        orderProducts: [orderProduct],
        shipment: shipment
      };
      var shipmentIndex = -1;
  		
  		// Set whether product is added to shippable, shipped or unshippable groups
  		if (isShipped) {
    		console.log('product is shipped');
    		// Check whether product is being added to an existing shipment group
    		
    		shippedGroups.map(function(shippedGroup, j) {
      		if (shippedShipmentId === shippedGroup.shippedShipmentId) shipmentIndex = j;
      		return shippedGroups;
    		});
        if (shipmentIndex < 0) {
          console.log('not in shippedGroups')
          shippedGroups.push(group);
        } else {
          console.log('found in shippedGroups')
          shippedGroups[shipmentIndex].orderProducts.push(orderProduct);
        }
    		
  		} else if (orderProduct.shippable && orderProduct.quantity_shipped !== orderProduct.quantity && orderProduct.variant.inventoryLevel >= orderProduct.quantity) { 
    		console.log('product is shippable');
    		
    		// Check whether product is being shipped to a unique address
    		shippableGroups.map(function(shippableGroup, j) {
      		if (orderProduct.order_address_id === shippableGroup.orderAddressId) shipmentIndex = j;
      		return shippableGroups;
    		});
        if (shipmentIndex < 0) {
          console.log('not in shippableGroups')
          shippableGroups.push(group);
        } else {
          console.log('found in shippableGroups')
          var groupProducts = shippableGroups[shipmentIndex].orderProducts;
          groupProducts.push(orderProduct);
          shippableGroups[shipmentIndex].orderProducts = groupProducts;
        }
    		
  		} else {
    		console.log('product is not shippable');
    		// Check whether product is being shipped to a unique address
    		unshippableGroups.map(function(unshippableGroup, j) {
      		if (orderProduct.order_address_id === unshippableGroup.orderAddressId) shipmentIndex = j;
      		return unshippableGroup;
    		});
        if (shipmentIndex < 0) {
          console.log('not in shippableGroups')
          unshippableGroups.push(group);
        } else {
          console.log('found in shippableGroups')
          unshippableGroups[shipmentIndex].orderProducts.push(orderProduct);
        }
    		
  		}
  		return orderProduct;
  		
		});
	}
  
  logInfo('createShipmentGroups completed');
  return {shippedGroups: shippedGroups, shippableGroups: shippableGroups, unshippableGroups: unshippableGroups};
}

var createOrderShipmentPackingSlip = function(order, shipment) {
  
  var pageWidth = 8.5 * 72;
  var pageHeight = 11 * 72;
  const padding = Math.round(72 / 4);
  const margin = Math.round(72 / 2);
  const pageCenterX = Math.round(pageWidth / 2);
  
  var promise = Parse.Promise.as();
  
  var fileName = 'packing-slip-' + order.get('orderId') + '-' + shipment.get('shipmentId') + '.pdf';
  logInfo(fileName);
  
  var writer = new streams.WritableStream();
  
  var pdfWriter = hummus.createWriter(new hummus.PDFStreamForResponse(writer));
  var page = pdfWriter.createPage(0, 0, pageWidth, pageHeight);
  var cxt = pdfWriter.startPageContentContext(page);
  
  // Fonts
  var regularFont = pdfWriter.getFontForFile(__dirname + '/../public/fonts/lato/Lato-Regular.ttf');
  var boldFont = pdfWriter.getFontForFile(__dirname + '/../public/fonts/lato/Lato-Bold.ttf');
  
  // Logo
  var logoXPos = pageWidth / 2 - 100;
  var logoYPos = pageHeight - 36 - 31;
  cxt.drawImage(logoXPos, logoYPos, __dirname + '/../public/img/logo.jpg', {transformation:{width:200,height:31, proportional:true}});
  
	// Company Address
	var companyAddress = writePdfText(cxt, '1112 Montana Ave #106, Santa Monica, California 90403', regularFont, 8, 0x999999, 'center', 0, logoYPos, padding, pageWidth, pageHeight);
  
  // Order Number
  var orderNumberHeadlineText = 'Packing Slip for Order #' + order.get('orderId');
  var orderNumberHeadline = writePdfText(cxt, orderNumberHeadlineText, boldFont, 18, 0x000000, 'center', 0, companyAddress.y, padding, pageWidth, pageHeight);
	
	// Line
	var lineYPos = orderNumberHeadline.y - padding;
	cxt.drawPath(margin, lineYPos, pageWidth - margin, lineYPos, {color:'lightgray', width:1});
	
  // Billing Details
  var billingAddress = shipment.get('billing_address');
  var billingDetails = writePdfText(cxt, 'Billing Details', boldFont, 12, 0x999999, 'left', margin, lineYPos, padding, pageWidth, pageHeight);
  var billingName = writePdfText(cxt, billingAddress.first_name + ' ' + billingAddress.last_name, boldFont, 10, 0x000000, 'left', margin, billingDetails.y, 12, pageWidth, pageHeight);
  var billingCompany = writePdfText(cxt, billingAddress.company, regularFont, 10, 0x000000, 'left', margin, billingName.y, 5, pageWidth, pageHeight);
  var billingStreet1 = writePdfText(cxt, billingAddress.street_1, regularFont, 10, 0x000000, 'left', margin, billingCompany.y, 5, pageWidth, pageHeight);
  var billingStreet2 = writePdfText(cxt, billingAddress.street_2, regularFont, 10, 0x000000, 'left', margin, billingStreet1.y, 5, pageWidth, pageHeight);
  var billingCityStateZip = writePdfText(cxt, billingAddress.city + ', ' + billingAddress.state + '  ' + billingAddress.zip, regularFont, 10, 0x000000, 'left', margin, billingStreet2.y, 5, pageWidth, pageHeight);
  var billingCountry = writePdfText(cxt, billingAddress.country, regularFont, 10, 0x000000, 'left', margin, billingCityStateZip.y, 5, pageWidth, pageHeight);
  var billingPhone = writePdfText(cxt, billingAddress.phone, regularFont, 10, 0x000000, 'left', margin, billingCountry.y, 5, pageWidth, pageHeight);
  var billingEmail = writePdfText(cxt, billingAddress.email, regularFont, 10, 0x000000, 'left', margin, billingPhone.y, 5, pageWidth, pageHeight);
	
  // Shipping Details
  var shippingAddress = shipment.get('shipping_address');
  var shippingDetails = writePdfText(cxt, 'Shipping Details', boldFont, 12, 0x999999, 'left', pageCenterX, lineYPos, padding, pageWidth, pageHeight);
  var shippingName = writePdfText(cxt, shippingAddress.first_name + ' ' + shippingAddress.last_name, boldFont, 10, 0x000000, 'left', pageCenterX, shippingDetails.y, 12, pageWidth, pageHeight);
  var shippingCompany = writePdfText(cxt, shippingAddress.company, regularFont, 10, 0x000000, 'left', pageCenterX, shippingName.y, 5, pageWidth, pageHeight);
  var shippingStreet1 = writePdfText(cxt, shippingAddress.street_1, regularFont, 10, 0x000000, 'left', pageCenterX, shippingCompany.y, 5, pageWidth, pageHeight);
  var shippingStreet2 = writePdfText(cxt, shippingAddress.street_2, regularFont, 10, 0x000000, 'left', pageCenterX, shippingStreet1.y, 5, pageWidth, pageHeight);
  var shippingCityStateZip = writePdfText(cxt, shippingAddress.city + ', ' + shippingAddress.state + '  ' + shippingAddress.zip, regularFont, 10, 0x000000, 'left', pageCenterX, shippingStreet2.y, 5, pageWidth, pageHeight);
  var shippingCountry = writePdfText(cxt, shippingAddress.country, regularFont, 10, 0x000000, 'left', pageCenterX, shippingCityStateZip.y, 5, pageWidth, pageHeight);
  var shippingPhone = writePdfText(cxt, shippingAddress.phone, regularFont, 10, 0x000000, 'left', pageCenterX, shippingCountry.y, 5, pageWidth, pageHeight);
  var shippingEmail = writePdfText(cxt, shippingAddress.email, regularFont, 10, 0x000000, 'left', pageCenterX, shippingPhone.y, 5, pageWidth, pageHeight);
	
  // Order Number
  var orderNumberText = 'Order: #' + order.get('orderId');
  var orderNumberY = shippingEmail.y < billingEmail.y ? shippingEmail.y : billingEmail.y;
  var orderNumber = writePdfText(cxt, orderNumberText, boldFont, 10, 0x000000, 'left', margin, orderNumberY, padding, pageWidth, pageHeight);
  
  // Payment Method
  var paymentMethodText = 'Payment Method: ' + order.get('payment_method') + ' (' + numeral(order.get('total_inc_tax')).format('$0,0.00') + ')';
  var paymentMethod = writePdfText(cxt, paymentMethodText, boldFont, 10, 0x000000, 'left', margin, orderNumber.y, 12, pageWidth, pageHeight);
  
  // Order Date
  var orderDateText = 'Order Date: ' + moment(order.get('date_created').iso).format('M/D/YY');
  var orderDate = writePdfText(cxt, orderDateText, boldFont, 10, 0x000000, 'left', pageCenterX, orderNumberY, padding, pageWidth, pageHeight);
  
  // Shipping Method
  var shippingMethodText = 'Shipping Method: ' + shipment.get('shipping_method');
  var shippingMethod = writePdfText(cxt, shippingMethodText, boldFont, 10, 0x000000, 'left', pageCenterX, orderDate.y, 12, pageWidth, pageHeight);
  
	// Line
	lineYPos = shippingMethod.y < paymentMethod.y ? shippingMethod.y - padding : paymentMethod.y - padding;
	cxt.drawPath(margin, lineYPos, pageWidth - margin, lineYPos, {color:'lightgray', width:1});
	
	// Order Items Heading
	var orderItemsHeading = writePdfText(cxt, 'Order Items', boldFont, 12, 0x999999, 'left', margin, lineYPos, padding, pageWidth, pageHeight);
	
	// Column Headings
	var columnHeadingY = orderItemsHeading.y;
	var quantityHeading = writePdfText(cxt, 'ORDERED', boldFont, 8, 0x000000, 'left', margin, columnHeadingY, padding, pageWidth, pageHeight);
	var shippedHeading = writePdfText(cxt, 'SHIPPED', boldFont, 8, 0x000000, 'left', margin + 50, columnHeadingY, padding, pageWidth, pageHeight);
	var codeSkuHeading = writePdfText(cxt, 'SKU', boldFont, 8, 0x000000, 'left', margin + 100, columnHeadingY, padding, pageWidth, pageHeight);
	var productNameHeading = writePdfText(cxt, 'PRODUCT NAME', boldFont, 8, 0x000000, 'left', margin + 180, columnHeadingY, padding, pageWidth, pageHeight);
	var priceHeading = writePdfText(cxt, 'PRICE', boldFont, 8, 0x000000, 'right', margin + 80, columnHeadingY, padding, pageWidth, pageHeight);
	var totalHeading = writePdfText(cxt, 'TOTAL', boldFont, 8, 0x000000, 'right', margin, columnHeadingY, padding, pageWidth, pageHeight);
	
	// Item Rows
	var shipmentItems = shipment.get('items');
	var orderProducts = order.get('orderProducts');
	var rowY = totalHeading.y - 10;
	var shippedProducts = [];
	var unshippedProducts = [];
	_.each(orderProducts, function(orderProduct) {
  	var inShipment = false;
    _.each(shipmentItems, function(shipmentItem) {
      if (shipmentItem.order_product_id == orderProduct.get('orderProductId')) {
        inShipment = true;
      }
    });
    if (!inShipment && orderProduct.get('quantity_shipped') < orderProduct.get('quantity')) {
      unshippedProducts.push(orderProduct);
    } else if (!inShipment && orderProduct.get('quantity_shipped') >= orderProduct.get('quantity')) {
      shippedProducts.push(orderProduct);
    }
    var rowColor = inShipment ? 0x000000 : 0x999999;
    var quantityText = writePdfText(cxt, orderProduct.get('quantity').toString(), regularFont, 9, rowColor, 'left', margin, rowY, 10, pageWidth, pageHeight);
    var shippedText = writePdfText(cxt, orderProduct.get('quantity_shipped').toString(), regularFont, 9, rowColor, 'left', margin + 50, rowY, 10, pageWidth, pageHeight);
    var skuText = writePdfText(cxt, orderProduct.get('sku'), regularFont, 9, rowColor, 'left', margin + 100, rowY, 10, pageWidth, pageHeight);
    var nameText = writePdfText(cxt, orderProduct.get('name'), regularFont, 9, rowColor, 'left', margin + 180, rowY, 10, pageWidth, pageHeight);
    var options = orderProduct.get('product_options');
    var optionsHeight = 0;
    _.each(options, function(option) {
      logInfo(option.display_name + ': ' + option.display_value)
      var optionText = writePdfText(cxt, option.display_name + ': ' + option.display_value, regularFont, 8, rowColor, 'left', margin + 180, nameText.y - optionsHeight, 5, pageWidth, pageHeight);
      optionsHeight += optionText.dims.height + 5;
    });
    var priceText = writePdfText(cxt, numeral(orderProduct.get('price_inc_tax')).format('$0,0.00'), regularFont, 9, rowColor, 'right', margin + 80, rowY, 10, pageWidth, pageHeight);
    var totalText = writePdfText(cxt, numeral(orderProduct.get('total_inc_tax')).format('$0,0.00'), regularFont, 9, rowColor, 'right', margin, rowY, 10, pageWidth, pageHeight);
    rowY -= (nameText.dims.height + optionsHeight + 10);
  });
  
	// Line
	lineYPos = rowY - padding;
	cxt.drawPath(margin, lineYPos, pageWidth - margin, lineYPos, {color:'lightgray', width:1});
	
	// Subtotal
	var subtotalLabel = writePdfText(cxt, 'Subtotal:', regularFont, 9, 0x000000, 'right', margin + 80, lineYPos, padding, pageWidth, pageHeight);
	var subtotalText = writePdfText(cxt, numeral(order.get('subtotal_ex_tax')).format('$0,0.00'), regularFont, 9, 0x000000, 'right', margin, lineYPos, padding, pageWidth, pageHeight);
	
	// Coupon
  var couponLabel = writePdfText(cxt, 'Coupon:', regularFont, 9, 0x000000, 'right', margin + 80, subtotalLabel.y, 10, pageWidth, pageHeight);
	var couponText = writePdfText(cxt, '-' + numeral(order.get('coupon_discount')).format('$0,0.00'), regularFont, 9, 0x000000, 'right', margin, subtotalLabel.y, 10, pageWidth, pageHeight);
	
	// Shipping
	var shippingLabel = writePdfText(cxt, 'Shipping:', regularFont, 9, 0x000000, 'right', margin + 80, couponLabel.y, 10, pageWidth, pageHeight);
	var shippingText = writePdfText(cxt, numeral(order.get('shipping_cost_ex_tax')).format('$0,0.00'), regularFont, 9, 0x000000, 'right', margin, couponLabel.y, 10, pageWidth, pageHeight);
	
	// Tax
	var taxLabel = writePdfText(cxt, 'Tax:', regularFont, 9, 0x000000, 'right', margin + 80, shippingLabel.y, 10, pageWidth, pageHeight);
	var taxText = writePdfText(cxt, numeral(order.get('total_tax')).format('$0,0.00'), regularFont, 9, 0x000000, 'right', margin, shippingLabel.y, 10, pageWidth, pageHeight);
	
	// Total
	var totalLabel = writePdfText(cxt, 'Grand Total:', boldFont, 9, 0x000000, 'right', margin + 80, taxLabel.y, 10, pageWidth, pageHeight);
	var totalText = writePdfText(cxt, numeral(order.get('total_inc_tax')).format('$0,0.00'), boldFont, 9, 0x000000, 'right', margin, taxLabel.y, 10, pageWidth, pageHeight);
  
  pdfWriter.writePage(page);
  pdfWriter.end();
  logInfo('packing slip pdf written');
  
  writer.end();
  var buffer = writer.toBuffer();
  
  // Save packing slip as a Parse File
  promise = promise.then(function() {
    var file = new Parse.File(fileName, {base64: buffer.toString('base64', 0, buffer.length)}, 'application/pdf');
    logInfo('save file');
    return file.save(null, {useMasterKey: true});
    
  }).then(function(packingSlip) {
    logInfo('file saved');
    shipment.set('packingSlip', packingSlip);
    shipment.set('packingSlipUrl', packingSlip.url());
    return shipment;
    
  }, function(error) {
    logError(error);
    return error;
    
  });
    
  return promise;
}

var writePdfText = function(cxt, text, font, fontSize, color, align, offsetX, offsetY, padding, pageWidth, pageHeight) {
  if (!text || text == '' || text == undefined || text == 'undefined') return { x: offsetX, y: offsetY, dims: { width:0, height: 0 } };
	var dims = font.calculateTextDimensions(text, fontSize);
	var pageMargin = Math.round(72 / 2);
	var x;
	switch (align) {
  	case 'center':
  	  x = offsetX + (pageWidth / 2) - (dims.width / 2);
  	  break;
  	case 'left':
  	  x = offsetX;
  	  break;
  	case 'right':
  	  x = pageWidth - offsetX - dims.width;
  	  break;
	  default: 
	    x = 0;
	    break;
	}
	var y = offsetY - padding - dims.height;
  cxt.writeText(text, x, y, { font: font, size: fontSize, colorspace: 'rgb', color: color });
  return {x:x, y:y, dims:dims};
}

var combinePdfs = function(pdfs) {
  
  var pdfBuffers = [];
  var pdfReadStreams = [];
  
  var promise = Parse.Promise.as();  
  promise = promise.then(function() {
    var promise2 = Parse.Promise.as();  
    
  	_.each(pdfs, function(pdf) {
    	
  		promise2 = promise2.then(function() {
    		logInfo('load: ' + pdf);
    		return Parse.Cloud.httpRequest({ url: pdf });
    		
  		}).then(function(response) {
    		pdfBuffers.push(response.buffer);
    		return true;
    		
      }, function(error) {
        logError(error);
        return false;
        
      });
  	});
  	return promise2;
  	
	}).then(function() {
  	logInfo(pdfBuffers.length + ' file buffers loaded');
  	
  	var writer = new streams.WritableStream();
  	var pdfWriter = hummus.createWriter(new hummus.PDFStreamForResponse(writer));
  	_.each(pdfBuffers, function(pdfBuffer) {
      var pdfReadStream = new PDFRStreamForBuffer(pdfBuffer);
    	pdfWriter.appendPDFPagesFromPDF(pdfReadStream);
  	});
  	pdfWriter.end();
  	logInfo('combined pdf written');
  	
  	// Save combined pdf as a Parse File
  	writer.end();
  	var buffer = writer.toBuffer();
    var fileName = 'combined.pdf';
    var file = new Parse.File(fileName, {base64: buffer.toString('base64', 0, buffer.length)}, 'application/pdf');
    logInfo('save file');
    return file.save(null, {useMasterKey: true});
    
  }).then(function(pdf) {
    logInfo('file saved');
  	return pdf;
  	
	}, function(error){
  	logError(error);
  	return false;
  	
	});
	
	return promise;
  
}

var logInfo = function(i) {
  console.info(i);
}

var logError = function(e) {
  var msg = e.message ? e.message.text ? e.message.text : JSON.stringify(e.message) : JSON.stringify(e);
  console.error(msg);
	bugsnag.notify(msg);
}