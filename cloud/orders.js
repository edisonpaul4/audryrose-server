var _ = require('underscore');
var moment = require('moment');
var numeral = require('numeral');
var BigCommerce = require('node-bigcommerce');
var bugsnag = require("bugsnag");
var hummus = require('hummus');
var streams = require('memory-streams');
var PDFRStreamForBuffer = require('../lib/pdfr-stream-for-buffer.js');
// var memwatch = require('memwatch-next');

// var loadOrder = require('./orders/load-order.js');

var Order = Parse.Object.extend('Order');
var OrderProduct = Parse.Object.extend('OrderProduct');
var OrderShipment = Parse.Object.extend('OrderShipment');
var Product = Parse.Object.extend('Product');
var ProductVariant = Parse.Object.extend('ProductVariant');
var BatchPdf = Parse.Object.extend('BatchPdf');
var Metric = Parse.Object.extend('Metric');
var MetricGroup = Parse.Object.extend('MetricGroup');

const ORDERS_PER_PAGE = 25;
const isProduction = process.env.NODE_ENV == 'production';
const isDebug = process.env.DEBUG == 'true';

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
  logInfo('getOrders cloud function --------------------', true);
  var startTime = moment();
  
  var totalOrders;
  var totalPages;
  var tabCounts = {};
  var orders;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'date-added-desc';
  var search = request.params.search ? request.params.search : null;
  var subpage = request.params.subpage ? request.params.subpage : 'awaiting-fulfillment';
  var paginate = true;
  var files = [];
  
  var ordersQuery = new Parse.Query(Order);
  
  if (search) {
    
    var toLowerCase = function(w) { return w.toLowerCase(); };
    
    var regex = new RegExp(search.toLowerCase(), 'gi');
    var searchTerms = search.split(' ');
    searchTerms = _.map(searchTerms, toLowerCase);
    
    var searchOrderNumberQuery = new Parse.Query(Order);
    searchOrderNumberQuery.matches('orderId', regex);
    var searchTermsQuery = new Parse.Query(Order);
    searchTermsQuery.containedIn('search_terms', searchTerms);
    ordersQuery = Parse.Query.or(searchOrderNumberQuery, searchTermsQuery);
    
  } else {
    
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
  ordersQuery.include('orderProducts.variants');
  ordersQuery.include('orderProducts.variants.designer');
  ordersQuery.include('orderProducts.vendorOrders');
  ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
  ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
  ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.vendor');
  ordersQuery.include('orderProducts.resizes');
  ordersQuery.include('orderProducts.awaitingInventory');
  ordersQuery.include('orderProducts.awaitingInventory.vendorOrder');
  ordersQuery.include('orderShipments');
  
  if (paginate) {
    ordersQuery.limit(ORDERS_PER_PAGE);
  } else {
    ordersQuery.limit(1000);
  }
  
  var tabCountsQuery = new Parse.Query(MetricGroup);
  tabCountsQuery.equalTo('objectClass', 'Order');
  tabCountsQuery.equalTo('slug', 'tabCounts');
  tabCountsQuery.descending('createdAt');
  tabCountsQuery.include('metrics');
    
  tabCountsQuery.first().then(function(result) {
    var ordersCount;
    if (result) {
      _.each(result.get('metrics'), function(metric) {
        switch (metric.get('slug')) {
          case 'awaitingFulfillment':
            tabCounts.awaitingFulfillment = metric.get('count');
            if (subpage == 'awaiting-fulfillment') ordersCount = metric.get('count');
            break;
          case 'resizable':
            tabCounts.resizable = metric.get('count');
            if (subpage == 'resizable') ordersCount = metric.get('count');
            break;
          case 'fullyShippable':
            tabCounts.fullyShippable = metric.get('count');
            if (subpage == 'fully-shippable') ordersCount = metric.get('count');
            break;
          case 'partiallyShippable':
            tabCounts.partiallyShippable = metric.get('count');
            if (subpage == 'partially-shippable') ordersCount = metric.get('count');
            break;
          case 'cannotShip':
            tabCounts.cannotShip = metric.get('count');
            if (subpage == 'cannot-ship') ordersCount = metric.get('count');
            break;
          case 'fulfilled':
            tabCounts.fulfilled = metric.get('count');
            if (subpage == 'fulfilled') ordersCount = metric.get('count');
            break;
          default:
            break;
        }
      });
    }
    
    if (ordersCount != undefined) {
      return ordersCount;
    } else {
      return ordersQuery.count();
    }
        
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
    logInfo('getOrders completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    
    if (ordersResult.shippable || ordersResult.partiallyShippable) {
      totalOrders = ordersResult.shippable.length + ordersResult.partiallyShippable.length + ordersResult.unshippable.length;
      switch (subpage) {
        case 'fully-shippable':
          tabCounts.fullyShippable = ordersResult.shippable.length;
          orders = ordersResult.shippable;
          totalPages = 1;
          break;
        case 'partially-shippable':
          tabCounts.partiallyShippable = ordersResult.partiallyShippable.length;
          orders = ordersResult.partiallyShippable;
          totalPages = 1;
          break;
        default:
          orders = ordersResult;
          totalPages = 1;
          break;
      }
      
    } else {
      orders = ordersResult;
    }
    
    var batchPdfsQuery = new Parse.Query(BatchPdf);
    batchPdfsQuery.limit(20);
    batchPdfsQuery.descending('createdAt');
    return batchPdfsQuery.find();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(result) {
    _.each(result, function(batchPdf) {
      var file = batchPdf.get('file')
      files.push({name: batchPdf.get('name'), createdAt: batchPdf.get('createdAt'), url: file.url()});
    });
    
    response.success({orders: orders, totalPages: totalPages, totalOrders: totalOrders, tabCounts: tabCounts, files: files});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("updateOrderTabCounts", function(request, response) {  
  logInfo('updateOrderTabCounts cloud function --------------------', true);
  var startTime = moment();
  
  var tabs = {};
  var inventoryBasedUnshippable = 0;
  var inventoryBasedPartiallyShippable = 0;
  var metrics = [];
  
  var awaitingFulfillmentQuery = getPendingOrderQuery();
  
  var resizableQuery = getPendingOrderQuery();
  resizableQuery.equalTo('fullyShippable', false);
  resizableQuery.equalTo('resizable', true); 
  
  var fullyShippableQuery = getPendingOrderQuery();
  fullyShippableQuery.equalTo('fullyShippable', true);  
  fullyShippableQuery.include('orderProducts');
//   fullyShippableQuery.include('orderProducts.variant');
  fullyShippableQuery.include('orderProducts.variants');
  fullyShippableQuery.include('orderProducts.vendorOrders');
  fullyShippableQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
  fullyShippableQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
  fullyShippableQuery.include('orderProducts.resizes');
  
  var partiallyShippableQuery = getPendingOrderQuery();
  partiallyShippableQuery.equalTo('partiallyShippable', true);  
  partiallyShippableQuery.include('orderProducts');
//   partiallyShippableQuery.include('orderProducts.variant');
  partiallyShippableQuery.include('orderProducts.variants');
  partiallyShippableQuery.include('orderProducts.vendorOrders');
  partiallyShippableQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
  partiallyShippableQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
  partiallyShippableQuery.include('orderProducts.resizes');
  
  var cannotShipQuery = getPendingOrderQuery();
  cannotShipQuery.equalTo('fullyShippable', false);
  cannotShipQuery.equalTo('partiallyShippable', false); 
  
  var fulfilledQuery = new Parse.Query(Order);
  fulfilledQuery.equalTo('status', 'Shipped');
  
  awaitingFulfillmentQuery.count().then(function(count) {
    tabs.awaitingFulfillment = count;
    metrics.push(createMetric('Order', 'awaitingFulfillment', 'Awaiting Fulfillment', count));
    return resizableQuery.count();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(count) {
    tabs.resizable = count;
    metrics.push(createMetric('Order', 'resizable', 'Resizable', count));
    return getInventoryAwareShippableOrders(fullyShippableQuery, 'fully-shippable');
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(ordersResult) {
    tabs.fullyShippable = ordersResult.shippable.length;
    metrics.push(createMetric('Order', 'fullyShippable', 'Fully Shippable', ordersResult.shippable.length));
    if (ordersResult.partiallyShippable.length > 0) inventoryBasedPartiallyShippable += ordersResult.partiallyShippable.length;
    if (ordersResult.unshippable.length > 0) inventoryBasedUnshippable += ordersResult.unshippable.length;
    return getInventoryAwareShippableOrders(partiallyShippableQuery, 'partially-shippable');
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(ordersResult) {
    tabs.partiallyShippable = ordersResult.partiallyShippable.length;
    metrics.push(createMetric('Order', 'partiallyShippable', 'Partially Shippable', ordersResult.partiallyShippable.length));
    if (ordersResult.unshippable.length > 0) inventoryBasedUnshippable += ordersResult.unshippable.length;
    return cannotShipQuery.count();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(count) {
    tabs.cannotShip = count;
    metrics.push(createMetric('Order', 'cannotShip', 'Cannot Ship', count));
    if (inventoryBasedUnshippable > 0) tabs.cannotShip += inventoryBasedUnshippable;
    return fulfilledQuery.count();
    
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  }).then(function(count) {
    tabs.fulfilled = count;
    metrics.push(createMetric('Order', 'fulfilled', 'Fulfilled', count));
    return Parse.Object.saveAll(metrics, {useMasterKey: true});
    
  }).then(function(results) {
    var metricGroup = new MetricGroup();
    metricGroup.set('objectClass', 'Order');
    metricGroup.set('slug', 'tabCounts');
    metricGroup.set('name', 'Tab Counts');
    metricGroup.set('metrics', results);
    return metricGroup.save(null, {useMasterKey: true});
    
  }).then(function(result) {
    
    logInfo('updateOrderTabCounts completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success(tabs);
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("loadOrder", function(request, response) {
  logInfo('loadOrder cloud function --------------------', true);
  var startTime = moment();
  
  var bcOrderId = request.params.orderId;
  
  loadOrder(bcOrderId).then(function(res) {
    logInfo('loadOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    response.success({added: res.added});
    
  }, function(error) {
    logError(error);
    response.error(error.message);
		
	});
});

Parse.Cloud.define("reloadOrder", function(request, response) {
  logInfo('reloadOrder cloud function --------------------', true);
  var startTime = moment();
  
  var orderId = parseInt(request.params.orderId);
  var updatedOrder;
  var bcOrder;
  var tabCounts;
  
  logInfo('reloadOrder ' + orderId + ' ------------------------');
  
  loadOrder(orderId).then(function(response) {
    logInfo('get order data');
    var ordersQuery = new Parse.Query(Order);
    ordersQuery.equalTo("orderId", orderId);
    ordersQuery.include('orderProducts');
    ordersQuery.include('orderProducts.variants');
    ordersQuery.include('orderProducts.variants.designer');
    ordersQuery.include('orderProducts.vendorOrders');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.vendor');
    ordersQuery.include('orderProducts.resizes');
    ordersQuery.include('orderProducts.awaitingInventory');
    ordersQuery.include('orderProducts.awaitingInventory.vendorOrder');
    ordersQuery.include('orderShipments');
    return ordersQuery.first();
    
  }).then(function(result) {
    updatedOrder = result;
    
    return Parse.Cloud.run('updateOrderTabCounts');
    
  }).then(function(result) {
    tabCounts = result;
    
    logInfo('order successfully reloaded');
    logInfo('reloadOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success({updatedOrders: [updatedOrder], tabCounts: tabCounts});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

Parse.Cloud.define("saveOrder", function(request, response) {
  logInfo('saveOrder cloud function --------------------------', true);
  var startTime = moment();
  
  var orderId = parseInt(request.params.data.orderId);
  var dateNeeded = request.params.data.dateNeeded !== undefined ? request.params.data.dateNeeded : undefined;
  
  var order;
  var updatedOrder;
  
  var orderQuery = new Parse.Query(Order);
  orderQuery.equalTo('orderId', orderId);
  orderQuery.first().then(function(result) {
    order = result;
    if (dateNeeded) {
      order.set('dateNeeded', dateNeeded);
    } else {
      order.unset('dateNeeded');
    }
    return order.save(null, {useMasterKey: true});
    
  }).then(function(result) {
    var ordersQuery = new Parse.Query(Order);
    ordersQuery.equalTo("orderId", orderId);
    ordersQuery.include('orderProducts');
    ordersQuery.include('orderProducts.variants');
    ordersQuery.include('orderProducts.variants.designer');
    ordersQuery.include('orderProducts.vendorOrders');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.vendor');
    ordersQuery.include('orderProducts.resizes');
    ordersQuery.include('orderProducts.awaitingInventory');
    ordersQuery.include('orderProducts.awaitingInventory.vendorOrder');
    ordersQuery.include('orderShipments');
    return ordersQuery.first();
    
  }).then(function(result) {
    updatedOrder = result;
    
    logInfo('saveOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    response.success({updatedOrders: [updatedOrder]});
    
  });
});

Parse.Cloud.define("createShipments", function(request, response) {
  logInfo('createShipments cloud function --------------------------', true);
  var startTime = moment();
  
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
    logInfo('total carriers ' + carriers.length, true);
    
    if (!shipmentGroups && ordersToShip) {
      logInfo('create shipment groups from order ids');
      shipmentGroups = [];
      
      var promise = Parse.Promise.as();
      _.each(ordersToShip, function(orderId) {
        promise = promise.then(function() {
          var orderQuery = new Parse.Query(Order);
          orderQuery.equalTo('orderId', parseInt(orderId));
          orderQuery.include('orderProducts');
          orderQuery.include('orderProducts.variants');
          orderQuery.include('orderProducts.vendorOrders');
          orderQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
          orderQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
          orderQuery.include('orderProducts.resizes');
          orderQuery.include('orderProducts.awaitingInventory');
          orderQuery.include('orderProducts.awaitingInventory.vendorOrder');
          orderQuery.include('orderShipments');
          return orderQuery.first();
          
        }).then(function(order) {
          var groups = createShipmentGroups(order, order.get('orderProducts'), order.get('orderShipments'));
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
    logInfo(shipmentGroups.length + ' shipment groups', true);
    
    var promise = Parse.Promise.as();
    _.each(shipmentGroups, function(shipmentGroup) {
      var orderId = shipmentGroup.orderId;
      var orderAddressId = shipmentGroup.orderAddressId;
      var shippingAddress = shipmentGroup.orderProducts[0].shippingAddress;
      var billingAddress = shipmentGroup.orderBillingAddress;
      var customShipment = shipmentGroup.customShipment ? shipmentGroup.customShipment : null;
      var bcShipment;
      var shippoLabel;
      var carrier;
      
      promise = promise.then(function() {
        
        logInfo('\nProcess order #' + orderId + ', address #' + shipmentGroup.orderAddressId, true);
        logInfo('Order address ' + shipmentGroup.orderAddressId + ' has ' + shipmentGroup.orderProducts.length + ' orderProducts', true);
        if (customShipment) {
          logInfo('customShipment: ' + customShipment, true);
        } else {
          logInfo('no customShipment');
        }

        // Load order shipments
        var request = '/orders/' + orderId + '/shipments?limit=' + BIGCOMMERCE_BATCH_SIZE;
        logInfo(request, true);
        return bigCommerce.get(request);
        
      }).then(function(bcOrderShipments) {
        
        if (bcOrderShipments && bcOrderShipments.length > 0) {
          logInfo('There are ' + bcOrderShipments.length + ' bigcommerce shipments for order id ' + orderId, true);
        } else {
          logInfo('There are 0 bigcommerce shipments for order id ' + orderId, true);
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
        
        if (shippingAddress.phone && validatePhoneNumber(shippingAddress.phone)) {
          addressTo.phone = shippingAddress.phone;
        } else {
          addressTo.phone = '14243878000';
        }
        if (shippingAddress.company) addressTo.company = shippingAddress.company;
        if (shippingAddress.street_2) addressTo.street2 = shippingAddress.street_2;
        
        var totalWeight = 0;
        var totalPrice = 0;
        _.map(shipmentGroup.orderProducts, function(p){
          totalPrice += parseFloat(p.total_inc_tax);
          totalWeight += parseFloat(p.weight * p.quantity); 
          return p;
        });
        
        var shipmentExtra = {
          bypass_address_validation: true
        };
        if (totalPrice >= 1000) {
          shipmentExtra.signature_confirmation = 'STANDARD';
          logInfo('shipment: signature required', true);
        } else {
          logInfo('shipment: no signature required', true);
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
        _.map(carriers, function(c){
          if (c.carrier == 'usps') carrier = c;
          return c;
        });

        // Overwrite shipment options if customizations exist
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
          object_purpose: "PURCHASE",
          extra: shipmentExtra
        };
        
        logInfo(shipment)
        logInfo(carrier.object_id, true)
        logInfo(serviceLevel, true)
        
        logInfo('do the shippo', true);
        
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
        logInfo('Order #' + orderId + ' Shippo label status: ' + httpResponse.data.object_status, true);
        if (httpResponse.data.object_status == 'SUCCESS') {
          
          shippoLabel = httpResponse.data;
          
          // Create the Bigcommerce shipment
          var request = '/orders/' + orderId + '/shipments';
          var items = [];
          _.each(shipmentGroup.orderProducts, function(orderProduct) { 
            logInfo('Adding order product ' + orderProduct.orderProductId + ' to shipment', true);
            items.push({order_product_id: orderProduct.orderProductId, quantity: orderProduct.quantity});
          });
          var bcShipmentData = {
            tracking_number: shippoLabel.tracking_number,
            comments: "",
            order_address_id: orderAddressId,
            shipping_provider: "",
            items: items
          }
          if ((carrier && carrier.carrier == 'usps') || (carrier && carrier.carrier == 'ups') || (carrier && carrier.carrier == 'fedex')) {
            bcShipmentData.shipping_provider = carrier.carrier;
            bcShipmentData.tracking_carrier = carrier.carrier;
          } else if (carrier && carrier.carrier == 'dhl_express') {
            bcShipmentData.shipping_provider = 'custom';
            bcShipmentData.tracking_carrier = 'dhl';
          }
          return bigCommerce.post(request, bcShipmentData);
          
        } else {
          _.each(httpResponse.data.messages, function(message) { 
            
            var msg = 'Error with Order #' + orderId + ': ' + message.text;
            logError(msg, true);
            errors.push(msg);
          });
        }
        
      }, function(error) {
        if (error.status) {
          logError('Error status: ' + error.status + ', Message: ' + error.text);
        } else {
          logError(error);
        }
    
      }).then(function(bcShipmentResult) {
        //if (!isNew) return true; // Skip if Bigcommerce shipment exists
        if (bcShipmentResult) {
          bcShipment = bcShipmentResult;
          
          logInfo('Bigcommerce shipment ' + bcShipment.id + ' created', true);
          
          var orderShipmentQuery = new Parse.Query(OrderShipment);
          orderShipmentQuery.equalTo('shipmentId', parseInt(bcShipment.id));
      		return orderShipmentQuery.first();
    		
    		} else {
      		logInfo('No BC shipment created for order ' + orderId, true);
    		}
    		
  		}, function(error) {
        logError(error);
    
      }).then(function(orderShipmentResult) {
        if (orderShipmentResult) {
          logInfo('OrderShipment ' + orderShipmentResult.get('shipmentId') + ' exists.', true);
          return createOrderShipmentObject(bcShipment, shippoLabel, orderShipmentResult).save(null, {useMasterKey: true});
        } else if (bcShipment) {
          logInfo('OrderShipment is new.', true);
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
    		logInfo('Order shipment saved to order', true);
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
      if (allOrderIds.indexOf(s.get('order_id')) < 0) allOrderIds.push(s.get('order_id'));
    });
    _.each(shipmentGroupsFailed, function(s) { 
      if (allOrderIds.indexOf(s.orderId) < 0) allOrderIds.push(s.orderId);
    });
    logInfo('orderIds to save: ' + allOrderIds.join(','), true);
    
    // Load each order into updatedOrdersArray with pointers
    var promise = Parse.Promise.as();
    _.each(allOrderIds, function(orderIdToLoad) {
      promise = promise.then(function() {
        return loadOrder(orderIdToLoad);
          
      }).then(function(response) {
        logInfo('get order data', true);
        var ordersQuery = new Parse.Query(Order);
        ordersQuery.equalTo('orderId', parseInt(orderIdToLoad));
        ordersQuery.include('orderProducts');
        ordersQuery.include('orderProducts.variants');
        ordersQuery.include('orderProducts.variants.designer');
        ordersQuery.include('orderProducts.vendorOrders');
        ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
        ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
        ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.vendor');
        ordersQuery.include('orderProducts.resizes');
        ordersQuery.include('orderProducts.awaitingInventory');
        ordersQuery.include('orderProducts.awaitingInventory.vendorOrder');
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
              logInfo('add to batch pdf: ' + orderShipment.get('labelWithPackingSlipUrl'), true);
              pdfsToCombine.push(orderShipment.get('labelWithPackingSlipUrl'));
            } else {
              var msg = 'Error: Order #' + orderShipment.get('order_id') + ' shipping label not added to combined print pdf file.';
              logInfo(msg, true);
              errors.push(msg);
            }
          }
        });
      });
    });
    if (pdfsToCombine.length > 0) {
      return combinePdfs(pdfsToCombine);
    } else {
      return;
    }
    
  }).then(function(result) {
    if (result) {
      logInfo('batch pdf generated', true);
      generatedFile = result.url();
      var batchPdf = new BatchPdf();
      batchPdf.set('file', result);
      var pdfName = newShipments.length + ' Shipments';
      batchPdf.set('name', pdfName);
      return batchPdf.save(null, {useMasterKey: true});
    } else {
      logInfo('no batch pdf generated', true);
      return;
    }
    
  }).then(function(result) {
    var newFiles = result ? [result] : null;
    logInfo('Created ' + newShipments.length + ' shipments. ' + shipmentGroupsFailed.length + ' shipment groups failed.', true);
    logInfo('createShipments completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
    response.success({updatedOrders: updatedOrdersArray, errors: errors, generatedFile: generatedFile, newFiles: newFiles});
    
  }, function(error) {
    logError(error);
    response.error(error.message);
  });

  
});

Parse.Cloud.define("batchCreateShipments", function(request, response) {
  logInfo('batchCreateShipments cloud function --------------------------', true);
  var startTime = moment();
  
  var ordersToShip = request.params.ordersToShip;
  var updatedOrders = [];
  var allShipmentGroups = [];
  var tabCounts;
  var generatedFile;
  var newFiles = [];
  
  // Create shipment groups
    
  Parse.Cloud.run('createShipments', {ordersToShip: ordersToShip}).then(function(result) {
    updatedOrders = result.updatedOrders;
    errors = result.errors;
    generatedFile = result.generatedFile;
    newFiles = result.newFiles;
    
    return Parse.Cloud.run('updateOrderTabCounts');
    
  }, function(error) {
	  logError(error);
	  response.error(error);
	  
  }).then(function(result) {
    tabCounts = result;
    
    logInfo('order successfully reloaded', true);
    logInfo('batchCreateShipments completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success({updatedOrders: updatedOrders, tabCounts: tabCounts, errors: errors, generatedFile: generatedFile, newFiles: newFiles});
	  
  }, function(error) {
	  logError(error);
	  response.error(error);
	  
  });
});

Parse.Cloud.define("batchPrintShipments", function(request, response) {
  logInfo('batchPrintShipments cloud function --------------------------', true);
  var startTime = moment();
  
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
      
      // Get the most recent shipment
      var mostRecentShipment;
      _.each(orderShipments, function(orderShipment) {
        logInfo(orderShipment.get('shipmentId'));
        if (!mostRecentShipment) {
          mostRecentShipment = orderShipment;
        } else if (orderShipment.get('shipmentId') > mostRecentShipment.get('shipmentId')) {
          mostRecentShipment = orderShipment;
        }
      });
      logInfo('most recent: ' + mostRecentShipment.get('shipmentId'));
      if (mostRecentShipment.has('labelWithPackingSlipUrl')) {
        logInfo('add to batch pdf: ' + mostRecentShipment.get('labelWithPackingSlipUrl'));
        pdfsToCombine.push(mostRecentShipment.get('labelWithPackingSlipUrl'));
      } else {
        var msg = 'Error: Order #' + mostRecentShipment.get('order_id') + ' shipping label not added to combined print file.';
        logInfo(msg);
        errors.push(msg);
      }
    });
    return combinePdfs(pdfsToCombine);
    
  }, function(error) {
	  logError(error);
	  errors.push(error.message);
	  
  }).then(function(result) {
    if (result) {
      logInfo('batch pdf generated');
      generatedFile = result.url();
      var batchPdf = new BatchPdf();
      batchPdf.set('file', result);
      var pdfName = ordersToPrint.length + ' Orders';
      batchPdf.set('name', pdfName);
      return batchPdf.save(null, {useMasterKey: true});
    } else {
      logError('no batch pdf generated');
      errors.push('Error creating combined shipping labels pdf.');
      return;
    }
    
  }).then(function(result) {
    var newFiles = result ? [result] : null;
    logInfo('batchPrintShipments completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success({generatedFile: generatedFile, errors: errors, newFiles: newFiles});
	  
  }, function(error) {
	  logError(error);
	  response.error(error);
	  
  });
});

Parse.Cloud.define("addOrderProductToVendorOrder", function(request, response) {
  logInfo('addOrderProductToVendorOrder cloud function --------------------------', true);
  var startTime = moment();
  
  var orders = request.params.orders;
  var orderId = request.params.orderId;
  var updatedProducts;
  var updatedOrder;
  var tabCounts;
  
  logInfo('addOrderProductToVendorOrder ' + orderId + ' ------------------------');
    
  Parse.Cloud.run('addToVendorOrder', {orders: orders, orderId: orderId}).then(function(result) {
    
    if (result.updatedProducts) updatedProducts = result.updatedProducts;
    
    logInfo('get order data');
    var ordersQuery = new Parse.Query(Order);
    ordersQuery.equalTo('orderId', orderId);
    ordersQuery.include('orderProducts');
    ordersQuery.include('orderProducts.variants');
    ordersQuery.include('orderProducts.variants.designer');
    ordersQuery.include('orderProducts.vendorOrders');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.orderProducts');
    ordersQuery.include('orderProducts.vendorOrders.vendorOrderVariants.vendor');
    ordersQuery.include('orderProducts.resizes');
    ordersQuery.include('orderProducts.awaitingInventory');
    ordersQuery.include('orderProducts.awaitingInventory.vendorOrder'); 
    ordersQuery.include('orderShipments');
    return ordersQuery.first();
    
  }).then(function(result) {
    updatedOrder = result;
    
    return Parse.Cloud.run('updateOrderTabCounts');
    
  }).then(function(result) {
    tabCounts = result;
    
    logInfo('order successfully reloaded');
    logInfo('addOrderProductToVendorOrder completion time: ' + moment().diff(startTime, 'seconds') + ' seconds', true);
	  response.success({updatedOrders: [updatedOrder], tabCounts: tabCounts});
	  
  }, function(error) {
	  logError(error);
	  response.error(error.message);
	  
  });
});

/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("Order", function(request, response) {
  logInfo('Order beforeSave --------------------------');
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
  logInfo('OrderShipment beforeSave --------------------------');
  var orderShipment = request.object;
  
  // Match the OrderShipment's items to a ProductVariant and decrement the inventoryLevel by quantity shipped
  if (!orderShipment.has('inventoryUpdated') || orderShipment.get('inventoryUpdated') == false) {
    var items = orderShipment.get('items');
    logInfo('order products need inventory updated for ' + items.length + ' items');
    var totalItemsProcessed = 0;
    var variantsToSave = [];
    var vendorOrderVariantsToSave = [];
    var resizesToSave = [];
    _.each(items, function(item) {
      logInfo('get product ' + item.order_product_id);
      var orderProductQuery = new Parse.Query(OrderProduct);
      orderProductQuery.equalTo('orderProductId', parseInt(item.order_product_id));
      orderProductQuery.include('variants');
      orderProductQuery.include('vendorOrders');
      orderProductQuery.include('vendorOrders.vendorOrderVariants');
      orderProductQuery.include('vendorOrders.vendorOrderVariants.orderProducts');
      orderProductQuery.include('resizes');
      orderProductQuery.first().then(function(orderProduct) {
        if (orderProduct) {
          logInfo('order product ' + orderProduct.get('orderProductId') + ' exists');
          if (orderProduct.has('variants')) {
            var variants = orderProduct.get('variants');
            _.each(variants, function(variant) {
              logInfo('order product variant ' + variant.get('variantId'));
              var totalToSubtract = parseInt(item.quantity);
              if (!variant.has('inventoryLevel')) variant.set('inventoryLevel', 0);
              
              // Check for received vendor orders and resizes with reserved inventory
              var totalReserved = 0;
              if (orderProduct.has('vendorOrders')) {
                _.each(orderProduct.get('vendorOrders'), function(vendorOrder) {
                  _.each(vendorOrder.get('vendorOrderVariants'), function(vendorOrderVariant) {
                    var reserved = vendorOrderVariant.get('received');
                    if (vendorOrderVariant.has('shipped')) {
                      reserved -= vendorOrderVariant.get('shipped');
                    } else {
                      vendorOrderVariant.set('shipped', 0);
                    }
                    _.each(vendorOrderVariant.get('orderProducts'), function(vendorOrderVariantProduct) {
                      if (vendorOrderVariantProduct.get('orderProductId') == orderProduct.get('orderProductId')) {
                        logInfo('order product ' + orderProduct.get('orderProductId') + ' has ' + reserved + ' inventory reserved from vendor order');
                        totalReserved += parseInt(item.quantity) > reserved ? reserved : parseInt(item.quantity);
                      }
                    });
                    if (totalReserved > 0 && reserved > 0) {
                      vendorOrderVariant.increment('shipped', reserved);
                    }
                    vendorOrderVariantsToSave.push(vendorOrderVariant);
                  });
                });
              }
              if (orderProduct.has('resizes')) {
                _.each(orderProduct.get('resizes'), function(resize) {
                  var reserved = resize.get('received');
                  if (resize.has('shipped')) {
                    reserved -= resize.get('shipped');
                  } else {
                    resize.set('shipped', 0);
                  }
                  logInfo('order product ' + orderProduct.get('orderProductId') + ' has ' + reserved + ' inventory reserved from resize');
                  totalReserved += parseInt(item.quantity) > reserved ? reserved : parseInt(item.quantity);
                  if (totalReserved > 0 && reserved > 0) {
                    resize.increment('shipped', reserved);
                  }
                  resizesToSave.push(resize);
                });
              }
              if (totalReserved > 0) totalToSubtract -= totalReserved;
              
              variant.increment('inventoryLevel', (totalToSubtract * -1));
              logInfo('Set inventory for variant ' + variant.get('variantId') + ' to ' + variant.get('inventoryLevel'), true);
              if (variant.get('inventoryLevel') < 0) {
                variant.set('inventoryLevel', 0);
                // TODO: Add activity log here for negative inventory level
                logInfo('Variant ' + variant.get('variantId') + ' was prevented from setting inventory to negative value', true);
              }
              variantsToSave.push(variant);
            });
          } else {
            logInfo('no variants for order product ' + orderProduct.get('orderProductId'));
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
          if (vendorOrderVariantsToSave.length > 0) {
            return Parse.Object.saveAll(vendorOrderVariantsToSave, {useMasterKey: true});
          } else {
            return true;
          }
        } else {
          return true;
        }
        
      }).then(function() {
        if (totalItemsProcessed == items.length) {
          logInfo('inventory saved for all vendor order variants');
          if (resizesToSave.length > 0) {
            return Parse.Object.saveAll(resizesToSave, {useMasterKey: true});
          } else {
            return true;
          }
        } else {
          return true;
        }
        
      }).then(function() {
        logInfo('inventory saved for all resizes');
        if (totalItemsProcessed == items.length) {
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

var loadOrder = function(bcOrderId) {
  logInfo('loadOrder function --------------------------', true);
  var bcOrder;
//   var bcOrderId = request.orderId;
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
  
  return bigCommerce.get(orderRequest).then(function(res) {
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
        orderProductQuery.include('vendorOrders');
        orderProductQuery.include('vendorOrders.vendorOrderVariants');
        orderProductQuery.include('resizes');
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
        logInfo('getOrderProductVariants for OrderProduct ' + orderProductObject.get('orderProductId'));
    		return getOrderProductVariants(orderProductObject);
    		
  		}, function(error){
    		logError(error);
    		
  		}).then(function(orderProductObject) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        logInfo('getOrderProductShippingAddress for OrderProduct ' + orderProductObject.get('orderProductId'));
    		return getOrderProductShippingAddress(orderProductObject);
    		
  		}, function(error){
    		logError(error);
    		
  		}).then(function(orderProductObject) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
    		// Set order product quantity shippped each time to update based on BC shipment changes
    		if (bcOrderShipments.length <= 0) {
      		logInfo('Set OrderProduct quantity shipped: 0');
      		orderProductObject.set('quantity_shipped', 0);
    		} else {
      		var totalShipped = 0;
      		_.each(bcOrderShipments, function(bcOrderShipment) {
        		_.each(bcOrderShipment.items, function(item) {
          		if (orderProduct.id == item.order_product_id) totalShipped += item.quantity;
        		});
      		});
      		logInfo('Set OrderProduct quantity shipped: ' + totalShipped);
      		orderProductObject.set('quantity_shipped', totalShipped);
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
    var numPartiallyShippable = 0;
    var numResizable = 0;
    var numShipped = 0;
    _.each(orderProducts, function(orderProduct) {
      if (orderProduct.has('shippable') && orderProduct.get('shippable') == true) numShippable++;
      if (orderProduct.has('partiallyShippable') && orderProduct.get('partiallyShippable') == true) numPartiallyShippable++;
      if (orderProduct.has('resizable') && orderProduct.get('resizable') == true) numResizable++;
      if (orderProduct.get('quantity_shipped') >= orderProduct.get('quantity')) numShipped++;
    });
    
    // Set order shippable status
    if (numShippable == orderProducts.length || numShippable == (orderProducts.length - numShipped)) {
      logInfo('set as fully shippable');
      orderObj.set('fullyShippable', true);
      orderObj.set('partiallyShippable', false);
    } else if (numShippable > 0) {
      logInfo('set as partially shippable');
      orderObj.set('fullyShippable', false);
      orderObj.set('partiallyShippable', true);
    } else if (numPartiallyShippable > 0) {
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
    		if (parseFloat(orderObj.get('status_id')) === 2 && orderShipmentObject.has('packingSlip')) {
      		logInfo('Do not create packing slip pdf');
      		return orderShipmentObject;
    		}
    		return createOrderShipmentPackingSlip(orderObj, orderShipmentObject);
    		
  		}).then(function(result) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
        
    		orderShipmentObject = result;
    		if (!orderShipmentObject.has('packingSlipUrl') || !orderShipmentObject.has('shippo_label_url') || (parseFloat(orderObj.get('status_id')) === 2 && orderShipmentObject.has('labelWithPackingSlip'))) {
      		logInfo('Do not create label with packing slip pdf')
      		return false;
    		}
    		return combinePdfs([orderShipmentObject.get('packingSlipUrl'), orderShipmentObject.get('shippo_label_url')]);
    		
  		}).then(function(result) {
//         var diff = hd.end();
//         if (diff.change.size_bytes > 0) logInfo('    + loadOrder memory increase:' + diff.change.size + ' total:' + diff.after.size);
//         hd = new memwatch.HeapDiff();
            		
    		if (result) {
      		logInfo('Save labelWithPackingSlip');
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
    return {added: orderAdded};
    
  }, function(error) {
    logError(error);
    return error;
		
	});

}

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
  var shippedOrderProducts = [];
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
//       logInfo('\ngetInventoryAwareShippableOrders order: ' + order.get('orderId'));
      var orderProducts = order.get('orderProducts');
      _.each(orderProducts, function(orderProduct) {
        var variants = orderProduct.get('variants');
        var vendorOrders = orderProduct.get('vendorOrders');
        var resizes = orderProduct.get('resizes');
        if (orderProduct.get('quantity_shipped') >= orderProduct.get('quantity')) {
//           logInfo('orderProduct ' + orderProduct.id + ' is shipped');
          shippedOrderProducts.push(orderProduct);
        } else if (variants) {
          var counted = false;
          var orderProductShippable = true;
          for (var i = 0; i < variantsOrderedCount.length; i++) {
            var item = variantsOrderedCount[i];
            _.each(variants, function(variant) {
              if (item.variantId == variant.id) {
                var totalOrdered = item.totalOrdered + orderProduct.get('quantity');
//                 logInfo('totalOrdered:' + totalOrdered + ' inventory:' + variant.get('inventoryLevel'))
                if (totalOrdered <= variant.get('inventoryLevel')) {
                  variantsOrderedCount[i].totalOrdered = totalOrdered;
                } else {
                  orderProductShippable = false;
                }
                counted = true;
              }
            });
          }
          if (counted && orderProductShippable) {
//             logInfo('orderProduct ' + orderProduct.id + ' is shippable');
            shippableOrderProducts.push(orderProduct);
          } else if (counted) {
//             logInfo('orderProduct ' + orderProduct.id + ' is not shippable');
            unshippableOrderProducts.push(orderProduct);
          } else if (!counted && orderProduct.get('quantity') <= getInventoryLevel(variants, vendorOrders, resizes)) {
//             logInfo('new orderProduct ' + orderProduct.id + ' is shippable with ' + orderProduct.get('quantity') + ' total ordered');
            _.each(variants, function(variant) {
              variantsOrderedCount.push({variantId: variant.id, totalOrdered: orderProduct.get('quantity')});
            });
            shippableOrderProducts.push(orderProduct);
          } else if (!counted && orderProduct.get('quantity') > getInventoryLevel(variants, vendorOrders, resizes)) {
//             logInfo('new orderProduct ' + orderProduct.id + ' is not shippable with ' + orderProduct.get('quantity') + ' total ordered');
            unshippableOrderProducts.push(orderProduct);
          }
        } else {
//           logInfo('order product does not have a variant');
        }
      });
    });
//     logInfo('shippableOrderProducts:' + shippableOrderProducts.length + ', unshippableOrderProducts:' + unshippableOrderProducts.length);
    ordersQuery = getOrderSort(ordersQuery, currentSort);
    return ordersQuery.find();
  
  }).then(function(ordersResult) {
//     logInfo('- - -');
    _.each(ordersResult, function(order) {
      var orderProducts = order.get('orderProducts');
      var totalShippableOrderProducts = 0;
      var totalShippedOrderProducts = 0;
      _.each(orderProducts, function(orderProduct) {
        _.each(shippableOrderProducts, function(shippableOrderProduct) {
          if (orderProduct.id == shippableOrderProduct.id) totalShippableOrderProducts++;
        });
        _.each(shippedOrderProducts, function(shippedOrderProduct) {
          if (orderProduct.id == shippedOrderProduct.id) totalShippedOrderProducts++;
        });
      });
      if ((orderProducts.length - totalShippedOrderProducts) == totalShippableOrderProducts) {
//         logInfo('order ' + order.get('orderId') + ' is shippable. op:' + orderProducts.length + ', shipped:' + totalShippedOrderProducts + ', shippable:' + totalShippableOrderProducts);
        shippableOrders.push(order);
      } else if (totalShippableOrderProducts > 0) {
//         logInfo('order ' + order.get('orderId') + ' is partially shippable. op:' + orderProducts.length + ', shipped:' + totalShippedOrderProducts + ', shippable:' + totalShippableOrderProducts);
        partiallyShippableOrders.push(order);
      } else {
//         logInfo('order ' + order.get('orderId') + ' is unshippable. op:' + orderProducts.length + ', shipped:' + totalShippedOrderProducts + ', shippable:' + totalShippableOrderProducts);
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

var getOrderProductVariants = function(orderProduct) {
  
  var promise = Parse.Promise.as();
  
  var parentProduct;
  
  // Match the OrderProduct to ProductVariants and save as an array of pointers
  var parentProductQuery = new Parse.Query(Product);
  parentProductQuery.equalTo('productId', orderProduct.get('product_id'));
  parentProductQuery.include('variants');
  parentProductQuery.include('bundleVariants');
  parentProductQuery.include('resizes');
  parentProductQuery.include('resizes.variant');
  
  promise = promise.then(function() {
    return parentProductQuery.first();
    
  }).then(function(result) {
    parentProduct = result;
    
    if (parentProduct && parentProduct.has('variants')) {
      var variants = parentProduct.has('variants') ? parentProduct.get('variants') : [];
      
      var variantMatches = [];
      if (parentProduct.has('isBundle') && parentProduct.get('isBundle') == true) {
        orderProduct.set('isBundle', true);
        var variantsToMatch = parentProduct.has('bundleVariants') ? parentProduct.get('bundleVariants') : [];
        var bundleVariantMatches = getOrderProductVariantMatches(orderProduct, variants);
        for (var i = 0; i < variantsToMatch.length; i++) {
          var variant = variantsToMatch[i];
          if (bundleVariantMatches && bundleVariantMatches.length > 0) {
            for (var j = 0; j < bundleVariantMatches.length; j++) {
              var bundleVariant = bundleVariantMatches[j];
              if (variant.get('productId') == bundleVariant.get('productId')) {
                logInfo('getOrderProductVariants: add ' + bundleVariant.get('productId') + ' to bundle');
                variantMatches.push(bundleVariant);
                bundleVariantMatches.splice(j, 1);
                break;
              }
            }       
          } else {
            variantMatches.push(variant);
          }
        }
      } else {
        orderProduct.set('isBundle', false);
        variantMatches = getOrderProductVariantMatches(orderProduct, variants);
      }
      logInfo('getOrderProductVariants: set ' + variantMatches.length + ' variants to product');
      if (variantMatches) {
        orderProduct.set('variants', variantMatches);
        
/*
        // Check if any variants have resizes
        if (parentProduct.has('resizes')) {
          logInfo('parent product has resizes');
          var resizes = [];
          _.each(parentProduct.get('resizes'), function(resize) {
            _.each(variantMatches, function(variantMatch) {
              if (resize.has('variant')) logInfo(variantMatch.id + ', ' + resize.get('variant').id)
              if (resize.has('variant') && variantMatch.id == resize.get('variant').id && resize.get('done') == false) resizes.push(resize);
            });
          });
          orderProduct.set('resizes', resizes);
        } else {
          logInfo('parent product does not have resizes');
          orderProduct.unset('resizes');
        }
*/
      }
      
    } else if (result) {
      logInfo('getOrderProductVariants: product ordered has no variants');
      return false;
    } else {
      logInfo('getOrderProductVariants: custom product ordered without variants');
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
    logInfo('getOrderProductShippingAddress: ' + request);
    return bigCommerce.get(request);
    
  }).then(function(address) {
    if (address && address.id) {
      logInfo('getOrderProductShippingAddress: adding OrderProduct shipping address: ' + address.id);
      var shippingAddress = address;
      orderProduct.set('shippingAddress', shippingAddress);
    } else {
      logInfo('getOrderProductShippingAddress: Order product shipping address not found', true)
    }
    return orderProduct;
  }, function(error) {
    return orderProduct;
  });
  
  return promise;
}

var getOrderProductVariantMatches = function(orderProduct, variants) {
  var totalVariants = variants ? variants.length : 0;
  logInfo('getOrderProductVariantMatches: ' + totalVariants + ' variants found for product ' + orderProduct.get('product_id'));
  var productOptions = orderProduct.get('product_options');
  var totalProductOptions = productOptions ? productOptions.length : 0;
  logInfo('getOrderProductVariantMatches: product has ' + totalProductOptions + ' options');
  
  if (totalVariants == 1 && totalProductOptions == 0) {
    logInfo('getOrderProductVariantMatches: Matched 1 variant');
    return variants;
    
  } else {

    var matchingVariants = [];
    _.each(variants, function(variant) {
      var variantOptions = variant.has('variantOptions') ? variant.get('variantOptions') : [];
      
      var matchesProductOptions = false;
      var totalOptionsToCheck = totalProductOptions;
      var optionsChecked = 0;
      var optionMatches = 0;
      
//       logInfo('getOrderProductVariantMatches: variant ' + variant.get('variantId') + ' ' + ' totalOptionsToCheck:' + totalOptionsToCheck);

      _.each(productOptions, function(productOption) {
        optionsChecked++;
        _.each(variantOptions, function(variantOption) {
//           logInfo('check po:' + productOption.option_id + ' vo:' + variantOption.option_id + ', pv:' + productOption.value + ' vv:' + variantOption.option_value_id);
          if (productOption.option_id == variantOption.option_id && productOption.value == variantOption.option_value_id) {
//             logInfo('getOrderProductVariantMatches: matched option_id:' + productOption.option_id + ' option_value_id:' + productOption.value);
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
      
      if (matchesProductOptions) {
        logInfo('getOrderProductVariantMatches: Matched variant ' + variant.id);
        matchingVariants.push(variant);
      }
    });
    logInfo('getOrderProductVariantMatches: ' + matchingVariants.length + ' variants match');
    
    if (matchingVariants.length > 0 && orderProduct.has('isBundle') && orderProduct.get('isBundle') == true) {
      logInfo('getOrderProductVariantMatches: Is bundle, matched multiple variants');
      return matchingVariants; // TODO: MAKE SURE VARIANTS MATCH DEFAULT PRODUCT OPTIONS
      
    } else if (matchingVariants.length > 0) {
      matchedVariant = matchingVariants[0];
      logInfo('getOrderProductVariantMatches: Matched variant ' + matchedVariant.get('variantId'));
      return [matchedVariant];
    } else {
      logInfo('getOrderProductVariantMatches: Matched no variants');
      return matchingVariants;
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
    	
    	var orderProductVariants = orderProduct.has('variants') ? orderProduct.get('variants') : null;
    	var vendorOrders = orderProduct.has('vendorOrders') ? orderProduct.get('vendorOrders') : null;
    	var resizes = orderProduct.has('resizes') ? orderProduct.get('resizes') : null;
    	
      // Determine if product is in resizable class
      var isResizeProductType = (orderProductVariants && orderProductVariants.length == 1 && orderProductVariants[0].has('size_value')) ? true : false;
      // Determine inventory level of order product
      var inventoryLevel = orderProductVariants ? getInventoryLevel(orderProductVariants, vendorOrders, resizes) : 0;
      logInfo('OrderProduct has inventory: ' + inventoryLevel);
      
      var quantityToShip = orderProduct.has('quantity_shipped') ? orderProduct.get('quantity') - orderProduct.get('quantity_shipped') : orderProduct.get('quantity');
      logInfo('OrderProduct quantity to ship: ' + quantityToShip);
    	
    	if (orderProduct.has('quantity_shipped') && orderProduct.get('quantity_shipped') >= orderProduct.get('quantity')) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' has already shipped');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	orderProduct.set('partiallyShippable', false);
      	return orderProduct;

    	} else if (orderProduct.has('isCustom') && orderProduct.get('isCustom') == true) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' is custom');
      	// TODO: do something here with custom order products
      	return orderProduct;
      	
    	} else if (!orderProductVariants) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' does not have any variants');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	orderProduct.set('partiallyShippable', false);
        return orderProduct;
      	
    	} else if (inventoryLevel >= quantityToShip) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' is shippable');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', true);
      	orderProduct.set('partiallyShippable', false);
        return orderProduct;
        
    	} else if (inventoryLevel > 0 && inventoryLevel <= quantityToShip) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' is partially shippable');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	orderProduct.set('partiallyShippable', true);
        return orderProduct;
      	
    	} else if (!isResizeProductType) {
      	logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' is not a resizable product');
      	orderProduct.set('resizable', false);
      	orderProduct.set('shippable', false);
      	orderProduct.set('partiallyShippable', false);
        return orderProduct;
      	
    	} else {
      	// No inventory and OrderProduct has sizes, check if resizable
      	orderProduct.set('shippable', false);
      	orderProduct.set('partiallyShippable', false);
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
  var variants = orderProduct.get('variants');
  if (variants.length > 1) {
    logInfo('OrderProduct ' + orderProduct.get('orderProductId') + ' has multiple variants and is not resizable');
    orderProduct.set('resizable', false);
    return orderProduct;
  } else {
    var orderProductVariant = variants[0];
  }
  
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
                  logInfo('Variant size difference: ' + sizeDifference);
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
  		logInfo('\nop:' + orderProduct.get('orderProductId') + ' oa:' + orderProduct.get('order_address_id'));
  		
  		// Check if product is in a shipment
  		var isShipped = false;
  		var shippedShipmentId;
  		var shipment;
  		if (shippedShipments) {
    		shippedShipments.map(function(shippedShipment, j) {
      		var items = shippedShipment.get('items');
      		items.map(function(item, k) {
        		if (orderProduct.get('order_address_id') === shippedShipment.get('order_address_id') && orderProduct.get('orderProductId') === item.order_product_id) {
          		isShipped = true;
          		shippedShipmentId = shippedShipment.get('shipmentId');
          		shipment = shippedShipment;
        		}
        		return item;
      		});
      		return shippedShipments;
    		});
  		}
      var group = {
        orderId: orderProduct.get('order_id'), 
        orderAddressId: orderProduct.get('order_address_id'), 
        orderBillingAddress: order.get('billing_address'),
        shippedShipmentId: shippedShipmentId, 
        orderProducts: [orderProduct.toJSON()],
        shipment: shipment
      };
      var shipmentIndex = -1;
  		
  		// Set whether product is added to shippable, shipped or unshippable groups
  		if (isShipped) {
    		logInfo('product is shipped');
    		// Check whether product is being added to an existing shipment group
    		
    		shippedGroups.map(function(shippedGroup, j) {
      		if (shippedShipmentId === shippedGroup.shippedShipmentId) shipmentIndex = j;
      		return shippedGroups;
    		});
        if (shipmentIndex < 0) {
          logInfo('not in shippedGroups')
          shippedGroups.push(group);
        } else {
          logInfo('found in shippedGroups')
          shippedGroups[shipmentIndex].orderProducts.push(orderProduct.toJSON());
        }
    		
  		} else if (orderProduct.get('shippable') && orderProduct.get('quantity_shipped') !== orderProduct.get('quantity') && getInventoryLevel(orderProduct.get('variants'), orderProduct.get('vendorOrders'), orderProduct.get('resizes')) >= orderProduct.get('quantity')) { 
    		logInfo('product is shippable');
    		
    		// Check whether product is being shipped to a unique address
    		shippableGroups.map(function(shippableGroup, j) {
      		if (orderProduct.get('order_address_id') === shippableGroup.orderAddressId) shipmentIndex = j;
      		return shippableGroups;
    		});
        if (shipmentIndex < 0) {
          logInfo('not in shippableGroups')
          shippableGroups.push(group);
        } else {
          logInfo('found in shippableGroups')
          var groupProducts = shippableGroups[shipmentIndex].orderProducts;
          groupProducts.push(orderProduct.toJSON());
          shippableGroups[shipmentIndex].orderProducts = groupProducts;
        }
    		
  		} else {
    		logInfo('product is not shippable');
    		// Check whether product is being shipped to a unique address
    		unshippableGroups.map(function(unshippableGroup, j) {
      		if (orderProduct.get('order_address_id') === unshippableGroup.orderAddressId) shipmentIndex = j;
      		return unshippableGroup;
    		});
        if (shipmentIndex < 0) {
          logInfo('not in shippableGroups')
          unshippableGroups.push(group);
        } else {
          logInfo('found in shippableGroups')
          unshippableGroups[shipmentIndex].orderProducts.push(orderProduct.toJSON());
        }
    		
  		}
  		return orderProduct;
  		
		});
	}
  
  logInfo('createShipmentGroups completed');
  return {shippedGroups: shippedGroups, shippableGroups: shippableGroups, unshippableGroups: unshippableGroups};
}

var getInventoryLevel = function(orderProductVariants, vendorOrders, resizes) {
  // TODO: DEDUCT MULTIPLE OF THE SAME PRODUCT VARIANT
  var lowestInventoryLevel;
  _.each(orderProductVariants, function(orderProductVariant) {
    var inventoryLevel = orderProductVariant.has('inventoryLevel') && orderProductVariant.get('inventoryLevel') > 0 ? orderProductVariant.get('inventoryLevel') : 0;
    if (vendorOrders) {
      // Check for vendor order reserved inventory
      _.each(vendorOrders, function(vendorOrder) {
        _.each(vendorOrder.get('vendorOrderVariants'), function(vendorOrderVariant) {
          var variant = vendorOrderVariant.get('variant');
          if (variant.id == orderProductVariant.id) {
            var reserved = vendorOrderVariant.get('received');
            if (vendorOrderVariant.get('shipped')) reserved -= vendorOrderVariant.get('shipped');
            inventoryLevel = reserved;
          }
        });        
      });
    }
    if (resizes) {
      // Check for resizes reserved inventory
      _.each(resizes, function(resize) {
        var variant = resize.get('variant');
        if (variant.id == orderProductVariant.id) {
          var reserved = resize.get('received');
          if (resize.get('shipped')) reserved -= resize.get('shipped');
          logInfo('add ' + reserved + ' from reserved to inventory');
          inventoryLevel = reserved;
        }
      });
    }
    if (lowestInventoryLevel == undefined) {
      lowestInventoryLevel = inventoryLevel;
    } else if (inventoryLevel < lowestInventoryLevel) {
      lowestInventoryLevel = inventoryLevel;
    }
  });
  return lowestInventoryLevel;
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
//       logInfo(option.display_name + ': ' + option.display_value);
      var optionText = writePdfText(cxt, option.display_name + ': ' + option.display_value, regularFont, 8, rowColor, 'left', margin + 180, nameText.y - optionsHeight, 5, pageWidth, pageHeight);
      optionsHeight += optionText.dims.height + 5;
    });
    var priceText = writePdfText(cxt, numeral(orderProduct.get('price_inc_tax')).format('$0,0.00'), regularFont, 9, rowColor, 'right', margin + 80, rowY, 10, pageWidth, pageHeight);
    var totalText = writePdfText(cxt, numeral(orderProduct.get('total_inc_tax')).format('$0,0.00'), regularFont, 9, rowColor, 'right', margin, rowY, 10, pageWidth, pageHeight);
    rowY -= (nameText.dims.height + optionsHeight + 10);
  });
  
	// Line
/*
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
*/
  
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
  	return;
  	
	});
	
	return promise;
  
}

var validatePhoneNumber = function(string) {
  return string.match(/\d/g).length >= 10;
}

var createMetric = function(objectClass, slug, name, value) {
  var metric = new Metric();
  metric.set('objectClass', objectClass);
  metric.set('slug', slug);
  metric.set('name', name);
  metric.set('count', value);
  return metric;
}

var logInfo = function(i, alwaysLog) {
  if (!isProduction || isDebug || alwaysLog) console.info(i);
}

var logError = function(e) {
  var msg = e.message ? JSON.stringify(e) : e;
  console.error(msg);
	if (isProduction) bugsnag.notify(msg);
}