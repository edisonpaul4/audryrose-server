var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');

var Order = Parse.Object.extend('Order');
var OrderProduct = Parse.Object.extend('OrderProduct');
var OrderShipment = Parse.Object.extend('OrderShipment');
var Product = Parse.Object.extend('Product');
var ProductVariant = Parse.Object.extend('ProductVariant');

const ORDERS_PER_PAGE = 50;

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
//   var filters = request.params.filters ? request.params.filters : null;
  
  var ordersQuery = new Parse.Query(Order);
  
  if (search) {
    
    var toLowerCase = function(w) { return w.toLowerCase(); };
    
    var regex = new RegExp(search.toLowerCase(), 'gi');
    var searchTerms = search.split(' ');
    searchTerms = _.map(searchTerms, toLowerCase);
    
    console.log(searchTerms);
    
    var searchOrderNumberQuery = new Parse.Query(Order);
    searchOrderNumberQuery.matches('orderId', regex);
    var searchTermsQuery = new Parse.Query(Order);
    searchTermsQuery.containedIn('search_terms', searchTerms);
    ordersQuery = Parse.Query.or(searchOrderNumberQuery, searchTermsQuery);
    
  } else {
    
    console.log(subpage);
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
        break;
      case 'partially-shippable':
        ordersQuery = getPendingOrderQuery();
        ordersQuery.equalTo('partiallyShippable', true);
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
  ordersQuery.limit(ORDERS_PER_PAGE);
  ordersQuery.include('orderProducts');
  ordersQuery.include('orderProducts.variant');
  ordersQuery.include('orderProducts.variant.designer');
  ordersQuery.include('orderShipments');
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
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
    
  }).then(function(count) {
    totalOrders = count;
    totalPages = Math.ceil(totalOrders / ORDERS_PER_PAGE);
    ordersQuery.skip((currentPage - 1) * ORDERS_PER_PAGE);
    return ordersQuery.find({useMasterKey:true});
    
  }).then(function(orders) {
	  response.success({orders: orders, totalPages: totalPages, totalOrders: totalOrders, tabCounts: tabCounts});
	  
  }, function(error) {
	  console.error("Unable to get orders: " + error.message);
	  response.error("Unable to get orders: " + error.message);
	  
  });
});

Parse.Cloud.define("getOrderTabCounts", function(request, response) {  
  
  var tabs = {};
  
  var awaitingFulfillmentQuery = getPendingOrderQuery();
  
  var resizableQuery = getPendingOrderQuery();
  resizableQuery.equalTo('fullyShippable', false);
  resizableQuery.equalTo('resizable', true); 
  
  var fullyShippableQuery = getPendingOrderQuery();
  fullyShippableQuery.equalTo('fullyShippable', true);  
  
  var partiallyShippableQuery = getPendingOrderQuery();
  partiallyShippableQuery.equalTo('partiallyShippable', true);  
  
  var cannotShipQuery = getPendingOrderQuery();
  cannotShipQuery.equalTo('fullyShippable', false);
  cannotShipQuery.equalTo('partiallyShippable', false); 
  
  var fulfilledQuery = new Parse.Query(Order);
  fulfilledQuery.equalTo('status', 'Shipped');
  
  awaitingFulfillmentQuery.count().then(function(count) {
    tabs.awaitingFulfillment = count;
    return resizableQuery.count();
    
  }).then(function(count) {
    tabs.resizable = count;
    return fullyShippableQuery.count();
    
  }).then(function(count) {
    tabs.fullyShippable = count;
    return partiallyShippableQuery.count();
    
  }).then(function(count) {
    tabs.partiallyShippable = count;
    return cannotShipQuery.count();
    
  }).then(function(count) {
    tabs.cannotShip = count;
    return fulfilledQuery.count();
    
  }).then(function(count) {
    tabs.fulfilled = count;
	  response.success(tabs);
	  
  }, function(error) {
	  console.error("Unable to get order counts: " + error.message);
	  response.error("Unable to get order counts: " + error.message);
	  
  });
});

Parse.Cloud.define("loadOrder", function(request, response) {
  var bcOrder = request.params.order;
  var orderObj;
  var orderProducts = [];
  var orderShipments = [];
  var totalProductsAdded = 0;
  var totalShipmentsAdded = 0;
  var orderAdded = false;
  
  console.log('\nOrder ' + bcOrder.id + ' is ' + bcOrder.status + ' ------------------------');
  
  var orderQuery = new Parse.Query(Order);
  orderQuery.equalTo('orderId', parseInt(bcOrder.id));
  orderQuery.first().then(function(orderResult) {
    if (orderResult) {
      console.log('Order exists.');
      return createOrderObject(bcOrder, orderResult).save(null, {useMasterKey: true});
    } else {
      console.log('Order is new.');
      orderAdded = true;
      return createOrderObject(bcOrder).save(null, {useMasterKey: true});
    }
    
  }).then(function(result) {
    orderObj = result;
    
    // Load order products
    var request = '/orders/' + bcOrder.id + '/products?limit=' + BIGCOMMERCE_BATCH_SIZE;
    return bigCommerce.get(request);
    
  }).then(function(bcOrderProducts) {
    var promise = Parse.Promise.as();
		_.each(bcOrderProducts, function(orderProduct) {
  		promise = promise.then(function() {
    		console.log('Process orderProduct id: ' + orderProduct.id);
        var orderProductQuery = new Parse.Query(OrderProduct);
        orderProductQuery.equalTo('orderProductId', parseInt(orderProduct.id));
    		return orderProductQuery.first()
    		
  		}).then(function(orderProductResult) {
        if (orderProductResult) {
          console.log('OrderProduct ' + orderProductResult.get('orderProductId') + ' exists.');
          return createOrderProductObject(orderProduct, orderObj, orderProductResult);
        } else {
          console.log('OrderProduct ' + orderProduct.id + ' is new.');
          totalProductsAdded++;
          return createOrderProductObject(orderProduct, orderObj);
        }
    		
  		}).then(function(orderProductObject) {
    		return getOrderProductVariant(orderProductObject);
    		
  		}).then(function(orderProductObject) {
    		return getOrderProductShippingAddress(orderProductObject);
    		
  		}).then(function(orderProductObject) {
    		return orderProductObject.save(null, {useMasterKey: true});
    		
  		}).then(function(orderProductObject) {
    		return orderProducts.push(orderProductObject);
  		});
    });
    return promise;
    
  }).then(function(result) {
    console.log('total orderProducts: ' + orderProducts.length);
    orderObj.set('orderProducts', orderProducts);
    
    // Check shippable and resize status of each OrderProduct
    if (orderProducts.length > 0) {
      return getOrderProductsStatus(orderProducts);
    } else {
      return true;
    }
    
  }).then(function(result) {
    // Count the order's products shippable/resizable status
    var numShippable = 0;
    var numResizable = 0;
    _.each(orderProducts, function(orderProduct) {
      if (orderProduct.has('shippable') && orderProduct.get('shippable') == true) numShippable++;
      if (orderProduct.has('resizable') && orderProduct.get('resizable') == true) numResizable++;
    });
    
    // Set order shippable status
    if (numShippable == orderProducts.length) {
      orderObj.set('fullyShippable', true);
      orderObj.set('partiallyShippable', false);
    } else if (numShippable > 0) {
      orderObj.set('fullyShippable', false);
      orderObj.set('partiallyShippable', true);
    } else {
      orderObj.set('fullyShippable', false);
      orderObj.set('partiallyShippable', false);
    }
    
    // Set order resizable status
    if (numResizable > 0) {
      console.log('set as resizable');
      orderObj.set('resizable', true);
    } else {
      orderObj.set('resizable', false);
    }
    
    return true;
    
  }).then(function(result) {
    // Load order shipments
    var request = '/orders/' + bcOrder.id + '/shipments?limit=' + BIGCOMMERCE_BATCH_SIZE;
    return bigCommerce.get(request);
    
  }).then(function(bcOrderShipments) {
    if (bcOrderShipments.length) {
      console.log(bcOrderShipments.length + ' shipments found');
    } else {
      console.log('No shipments found');
      return true;
    }
    
    var promise = Parse.Promise.as();
		_.each(bcOrderShipments, function(orderShipment) {
  		promise = promise.then(function() {
    		console.log('Process shipment id: ' + orderShipment.id);
        var orderShipmentQuery = new Parse.Query(OrderShipment);
        orderShipmentQuery.equalTo('shipmentId', parseInt(orderShipment.id));
    		return orderShipmentQuery.first()
    		
  		}).then(function(orderShipmentResult) {
        if (orderShipmentResult) {
          console.log('OrderShipment ' + orderShipmentResult.get('shipmentId') + ' exists.');
          return createOrderShipmentObject(orderShipment, null, orderShipmentResult).save(null, {useMasterKey: true});
        } else {
          console.log('OrderShipment ' + orderShipment.id + ' is new.');
          totalShipmentsAdded++;
          return createOrderShipmentObject(orderShipment, null).save(null, {useMasterKey: true});
        }
    		
  		}).then(function(orderShipmentObject) {
    		return orderShipments.push(orderShipmentObject);
  		});
    });
    return promise;
    
  }).then(function(result) {
    if (orderShipments.length > 0) orderObj.set('orderShipments', orderShipments);
    console.log('save order...');
    orderObj.save(null, {useMasterKey: true});
    
  }).then(function(orderObj) {
    console.log('order saved');
    response.success({added: orderAdded});
    
  }, function(error) {
    console.error("Error saving order: " + error.message);
    response.error("Error saving order: " + error.message);
		
	});
});

Parse.Cloud.define("reloadOrder", function(request, response) {
  var orderId = parseInt(request.params.orderId);
  var updatedOrder;
  var bcOrder;
  var tabCounts;
  
  console.log('reloadOrder ' + orderId);

  var orderRequest = '/orders/' + orderId;
  console.log(orderRequest);
  bigCommerce.get(orderRequest).then(function(res) {
    bcOrder = res;
    
    return Parse.Cloud.httpRequest({
      method: 'post',
      url: process.env.SERVER_URL + '/functions/loadOrder',
      headers: {
        'X-Parse-Application-Id': process.env.APP_ID,
        'X-Parse-Master-Key': process.env.MASTER_KEY
      },
      params: {
        order: bcOrder
      }
    });
    
  }).then(function(response) {
    console.log('get order data');
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
    
    console.log('order successfully reloaded');
	  response.success({updatedOrders: [updatedOrder], tabCounts: tabCounts});
	  
  }, function(error) {
	  console.error("Unable to reload order: " + error.message);
	  response.error("Unable to reload order: " + error.message);
	  
  });
});

Parse.Cloud.define("createShipments", function(request, response) {
  var shipmentGroups = request.params.shipmentGroups;
  var carrier;
  var totalShipmentsAdded = 0;
  var updatedOrders = [];
  var newShipments = [];
  var newOrderShipment = [];
    
  Parse.Cloud.httpRequest({
    method: 'get',
    url: 'https://api.goshippo.com/carrier_accounts/',
    headers: {
      'Authorization': 'ShippoToken ' + process.env.SHIPPO_API_TOKEN
    },
    params: {
      carrier: 'usps'
    }
  }, function(error) {
    console.error(JSON.stringify(error));
    
  }).then(function(httpResponse) {
    carrier = httpResponse.data.results[0]; // Only using USPS for now, so array length should be zero
    console.log('carrier ' + carrier.object_id);
    
    var promise = Parse.Promise.as();
    _.each(shipmentGroups, function(shipmentGroup) {
      
      var orderId = shipmentGroup.orderId;
      var orderAddressId = shipmentGroup.orderAddressId;
      var shippingAddress = shipmentGroup.orderProducts[0].shippingAddress;
      var bcShipment;
      var shippoLabel;
      
      console.log('Process order address: ' + orderAddressId);
      
      promise = promise.then(function() {

        // Load order shipments
        var request = '/orders/' + orderId + '/shipments?limit=' + BIGCOMMERCE_BATCH_SIZE;
        console.log(request);
        return bigCommerce.get(request);
        
      }).then(function(bcOrderShipments) {
        
        if (bcOrderShipments.length > 0) {
          console.log('There are ' + bcOrderShipments.length + ' bigcommerce shipments for order id ' + orderId);
        } else {
          console.log('There are no bigcommerce shipments for order id ' + orderId);
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
        var addressTo = {
          object_purpose: "PURCHASE",
          name: name,
          company: shippingAddress.company,
          street1: shippingAddress.street_1,
          street2: shippingAddress.street_2,
          city: shippingAddress.city,
          state: shippingAddress.state,
          zip: shippingAddress.zip,
          country: shippingAddress.country_iso2,
          phone: shippingAddress.phone,
          email: shippingAddress.email
        };
        var totalWeight = 0;
        _.map(shipmentGroup.orderProducts, function(p){ 
          return totalWeight += (p.weight * p.quantity); 
        });
        totalWeight.toString();
        var parcel = {
          length: "8.69",
          width: "5.44",
          height: "1.75",
          distance_unit: "in",
          weight: totalWeight,
          mass_unit: "oz",
          template: "USPS_SmallFlatRateBox"
        }
        var shipment = {
          address_from: addressFrom,
          address_to: addressTo,
          parcel: parcel,
          object_purpose: "PURCHASE"
        };
        
        var serviceLevel = US_SHIPPING_ZONES.indexOf(shippingAddress.shipping_zone_id) >= 0 ? 'usps_priority' : 'usps_first_class_package_international_service';
        console.log('do the shippo');
        
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
        console.error(JSON.stringify(error));
    
      }).then(function(httpResponse) {
        console.log(JSON.stringify(httpResponse.data));
        if (httpResponse.data.object_status != 'SUCCESS') response.fail('Label could not be generated for order ' + orderId);
        shippoLabel = httpResponse.data;
        console.log('Shippo label status: ' + shippoLabel.object_status)
        
        // Create the Bigcommerce shipment
        var request = '/orders/' + orderId + '/shipments';
        var items = [];
        _.each(shipmentGroup.orderProducts, function(orderProduct) { 
          console.log('Adding order product ' + orderProduct.orderProductId + ' to shipment');
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
        
      }, function(error) {
        console.error(JSON.stringify(error));
    
      }).then(function(bcShipmentResult) {
        //if (!isNew) return true; // Skip if Bigcommerce shipment exists
        if (!bcShipmentResult) response.fail('Bigcommerce shipment could not be created for order ' + orderId);
        bcShipment = bcShipmentResult;
        
        console.log('Bigcommerce shipment ' + bcShipment.id + ' created');
        
        var orderShipmentQuery = new Parse.Query(OrderShipment);
        orderShipmentQuery.equalTo('shipmentId', parseInt(bcShipment.id));
    		return orderShipmentQuery.first();
    		
  		}, function(error) {
        console.error(JSON.stringify(error));
    
      }).then(function(orderShipmentResult) {
        if (orderShipmentResult) {
          console.log('OrderShipment ' + orderShipmentResult.get('shipmentId') + ' exists.');
          return createOrderShipmentObject(bcShipment, shippoLabel, orderShipmentResult).save(null, {useMasterKey: true});
        } else {
          console.log('OrderShipment ' + bcShipment.id + ' is new.');
          totalShipmentsAdded++;
          return createOrderShipmentObject(bcShipment, shippoLabel).save(null, {useMasterKey: true});
        }
        
  		}, function(error) {
        console.error(JSON.stringify(error));
    
      }).then(function(orderShipmentObject) {
        newOrderShipment = orderShipmentObject;
    		newShipments.push(newOrderShipment);
    		
        var orderQuery = new Parse.Query(Order);
        orderQuery.equalTo('orderId', parseInt(orderId));
        orderQuery.include('orderShipments');
    		return orderQuery.first();
    		
  		}).then(function(orderResult) {
    		orderResult.addUnique('orderShipments', newOrderShipment);
    		return orderResult.save(null, {useMasterKey: true});
    		
  		}).then(function(orderResult) {
    		console.log('Order shipment saved to order');
    		return true;
    		
      }, function(error) {
        console.error('Error creating shipment for order ' + orderId);
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
    console.log('orderIds to save: ' + allOrderIds.join(','));
    
    // Load each order into updatedOrders with pointers
    var promise = Parse.Promise.as();
    _.each(allOrderIds, function(orderId) {
      promise = promise.then(function() {
        var orderRequest = '/orders/' + orderId;
        console.log(orderRequest);
        return bigCommerce.get(orderRequest);
        
      }).then(function(bcOrder) {
        return Parse.Cloud.httpRequest({
          method: 'post',
          url: process.env.SERVER_URL + '/functions/loadOrder',
          headers: {
            'X-Parse-Application-Id': process.env.APP_ID,
            'X-Parse-Master-Key': process.env.MASTER_KEY
          },
          params: {
            order: bcOrder
          }
        });
          
      }).then(function(response) {
        console.log('get order data');
        var ordersQuery = new Parse.Query(Order);
        ordersQuery.equalTo("orderId", orderId);
        ordersQuery.include('orderProducts');
        ordersQuery.include('orderProducts.variant');
        ordersQuery.include('orderProducts.variant.designer');
        ordersQuery.include('orderShipments');
        return ordersQuery.first();
      
      }).then(function(orderResult) {
        updatedOrders.push(orderResult);
      });
    });
    return promise;
    
  }).then(function() {
    console.log('Successfully created ' + newShipments.length + ' shipments');
    response.success(updatedOrders);
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
    Parse.Object.fetchAll(orderProducts).then(function(orderProductObjects) {
      _.each(orderProductObjects, function(orderProduct) {
        // Add the product names as search terms
        var nameTerms = orderProduct.get('name').split(' ');
        nameTerms = _.map(nameTerms, toLowerCase);
        searchTerms = searchTerms.concat(nameTerms);
      });
      return searchTerms;
    }).then(function() {
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
    console.log('order products need inventory updated for ' + items.length + ' items');
    var totalItemsProcessed = 0;
    var variantsToSave = [];
    _.each(items, function(item) {
      console.log('get product ' + item.order_product_id);
      var orderProductQuery = new Parse.Query(OrderProduct);
      orderProductQuery.equalTo('orderProductId', parseInt(item.order_product_id));
      orderProductQuery.include('variant');
      orderProductQuery.first().then(function(result) {
        if (result) {
          console.log('order product ' + result.get('orderProductId') + ' exists');
          if (result.has('variant')) {
            var variant = result.get('variant');
            console.log('matches variant ' + variant.get('variantId'));
            var totalToSubtract = parseInt(item.quantity) * -1;
            if (!variant.has('inventoryLevel')) variant.set('inventoryLevel', 0);
            variant.increment('inventoryLevel', totalToSubtract);
            variantsToSave.push(variant);
          } else {
            console.log('no variant for order product ' + result.get('orderProductId'));
          }

        } else {
          console.log('order product does not exist ' + item.order_product_id);
        }
        totalItemsProcessed++;
        if (totalItemsProcessed == items.length) {
          console.log('all items processed');
          if (variantsToSave.length > 0) {
            console.log('save inventory for all variants');
            orderShipment.set('inventoryUpdated', true);
            return Parse.Object.saveAll(variantsToSave, {useMasterKey: true});
          } else {
            console.log('no variants to save');
            return true;
          }
        } else {
          return true;
        }
        
      }).then(function() {
        if (totalItemsProcessed == items.length) {
          console.log('inventory saved for all variants');
          response.success();
        } else {
          return true;
        }
      });
    });
  } else {
    console.log('order products do not need inventory updated');
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
  if (orderProductData.quantity) orderProduct.set('quantity', parseInt(orderProductData.quantity));
  if (orderProductData.base_cost_price) orderProduct.set('base_cost_price', parseFloat(orderProductData.base_cost_price));
  if (orderProductData.cost_price_inc_tax) orderProduct.set('cost_price_inc_tax', parseFloat(orderProductData.cost_price_inc_tax));
  if (orderProductData.cost_price_ex_tax) orderProduct.set('cost_price_ex_tax', parseFloat(orderProductData.cost_price_ex_tax));
  if (orderProductData.cost_price_tax) orderProduct.set('cost_price_tax', parseFloat(orderProductData.cost_price_tax));
  if (orderProductData.is_refunded != undefined) orderProduct.set('is_refunded', orderProductData.is_refunded);
  if (orderProductData.quantity_refunded) orderProduct.set('quantity_refunded', parseInt(orderProductData.quantity_refunded));
  if (orderProductData.refund_amount) orderProduct.set('refund_amount', parseFloat(orderProductData.refund_amount));
  if (orderProductData.return_id) orderProduct.set('return_id', parseInt(orderProductData.return_id));
  if (orderProductData.wrapping_name) orderProduct.set('wrapping_name', orderProductData.wrapping_name);
  if (orderProductData.base_wrapping_cost) orderProduct.set('base_wrapping_cost', parseFloat(orderProductData.base_wrapping_cost));
  if (orderProductData.wrapping_cost_ex_tax) orderProduct.set('wrapping_cost_ex_tax', parseFloat(orderProductData.wrapping_cost_ex_tax));
  if (orderProductData.wrapping_cost_inc_tax) orderProduct.set('wrapping_cost_inc_tax', parseFloat(orderProductData.wrapping_cost_inc_tax));
  if (orderProductData.wrapping_cost_tax) orderProduct.set('wrapping_cost_tax', parseFloat(orderProductData.wrapping_cost_tax));
  if (orderProductData.wrapping_message) orderProduct.set('wrapping_message', orderProductData.wrapping_message);
  if (orderProductData.quantity_shipped) orderProduct.set('quantity_shipped', parseInt(orderProductData.quantity_shipped));
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
        console.log(msg);
      }
    } else if (result) {
      console.log('product ordered has no variants');
      return false;
    } else {
      console.log('custom product ordered without variants');
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
    console.log('adding OrderProduct shipping address: ' + address.id);
    var shippingAddress = address;
    orderProduct.set('shippingAddress', shippingAddress);
    return orderProduct;
  }, function(error) {
    console.error('Error with getOrderProductShippingAddress: ' + JSON.stringify(error));
  });
  
  return promise;
}

var getOrderProductVariantMatch = function(orderProduct, variants) {
  console.log(variants.length + ' variants found for product ' + orderProduct.get('product_id'));
  var productOptions = orderProduct.get('product_options');
  var totalProductOptions = productOptions.length;
  console.log('product has ' + totalProductOptions + ' options');
  
  if (variants.length == 1 && productOptions.length == 0) {
    console.log('Matched ' + variants.length + ' variant');
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
    console.log(matchingVariants.length + ' variants match');

    if (matchingVariants.length > 0) { // TODO: make this match only 1 variant, if multiple, figure which is correct
      matchedVariant = matchingVariants[0];
      console.log('Matched variant ' + matchedVariant.get('variantId'));
      return matchedVariant;
    } else {
      console.log('Matched ' + matchingVariants.length + ' variants');
      return null;
    }
  }

}

var getOrderProductsStatus = function(orderProducts) {
  
  var promise = Parse.Promise.as();
  
  promise = promise.then(function() {
    
  	_.each(orderProducts, function(orderProduct) {
    	
    	if (orderProduct.has('quantity_shipped') && orderProduct.get('quantity_shipped') >= orderProduct.get('quantity')) {
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	return true;
    	} else if (orderProduct.has('isCustom') && orderProduct.get('isCustom') == true) {
      	
    	}
    	
    	var orderProductVariant = orderProduct.has('variant') ? orderProduct.get('variant') : null;
      // Determine if product is in resizable class
      var isResizeProductType = (orderProductVariant && orderProductVariant.has('size_value')) ? true : false;
    	
    	if (!orderProductVariant) {
      	console.log('OrderProduct ' + orderProduct.get('product_id') + ' does not have any variants');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	return true;
      	
    	} else if (orderProductVariant.get('inventoryLevel') >= orderProduct.get('quantity')) {
      	// Has inventory, save it and exit
      	console.log('OrderProduct ' + orderProduct.get('product_id') + ' is shippable');
      	orderProduct.unset('resizable');
      	orderProduct.set('shippable', true);
      	return true;
      	
    	} else if (!isResizeProductType) {
      	console.log('OrderProduct ' + orderProduct.get('product_id') + ' is not a resizable product');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	return true;
      	
    	} else {
      	// No inventory and OrderProduct has sizes, check if resizable
      	orderProduct.set('shippable', false);
      	
      	var promise2 = Parse.Promise.as();
    		promise2 = promise2.then(function() {
      		var productQuery = new Parse.Query(Product);
      		productQuery.equalTo('productId', orderProduct.get('product_id'));
      		productQuery.include('variants');
      		return productQuery.first();
      		
    		}).then(function(result) {
          if (result) {
            console.log('Set product status for OrderProduct ' + orderProduct.get('product_id'));
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
                        console.log('\nVariant size difference: ' + sizeDifference);
                        console.log('Variant inventory: ' + variant.get('inventoryLevel')); 
                        console.log(orderProductVariantOption.display_name + ': ' + orderProductVariantOption.value + ' ' + variantOption.value);
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
            console.log(eligibleVariants.length + ' variants could be resized');
            if (eligibleVariants.length > 0) {
              orderProduct.set('resizable', true);
            } else {
              orderProduct.set('resizable', false);
            }
            return true;
          } else {
            var msg = 'Cannot determine product resizable for OrderProduct ' + orderProduct.get('product_id');
            console.log(msg);
            orderProduct.set('resizable', false);
            return true;
          }
    		});
    		return promise2;
  		}
  	});
	}).then(function() {
  	return Parse.Object.saveAll(orderProducts, {useMasterKey: true});
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
  console.log('save ' + items.length + ' items');
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
