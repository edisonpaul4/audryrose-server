var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');

var Order = Parse.Object.extend('Order');
var OrderProduct = Parse.Object.extend('OrderProduct');
var ProductVariant = Parse.Object.extend('ProductVariant');

const ORDERS_PER_PAGE = 50;

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
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getOrders", function(request, response) {
  var totalOrders;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  var currentSort = (request.params.sort) ? request.params.sort : 'date-added-desc';
  var search = request.params.search ? request.params.search : null;
  var subpage = request.params.subpage ? request.params.subpage : null;
//   var filters = request.params.filters ? request.params.filters : null;
  
  var ordersQuery = new Parse.Query(Order);
  
  if (search) {
    
    var regex = new RegExp(search.toLowerCase(), 'gi');
    var searchTerms = search.split(' ');
    var addPlural = function(term) { return term + 's'; };
    var pluralTerms = _.map(searchTerms, addPlural);
    searchTerms = searchTerms.concat(pluralTerms);
    
    var searchOrderNumberQuery = new Parse.Query(Order);
    searchOrderNumberQuery.matches('orderId', regex);
    var searchTermsQuery = new Parse.Query(Order);
    searchTermsQuery.containedIn('search_terms', searchTerms);
    ordersQuery = Parse.Query.or(searchOrderNumberQuery, searchTermsQuery);
    
  } else {
    ordersQuery.notEqualTo('status', 'Incomplete');
    
/*
    if (filters.designer && filters.designer != 'all') {
      var designerQuery = new Parse.Query(Designer);
      designerQuery.equalTo('name', filters.designer);
      productsQuery.matchesQuery('designer', designerQuery);
    }
    
    if (filters.price && filters.price != 'all') {
      var price = filters.price.split('-');
      var min = parseFloat(price[0]);
      var max = price[1] ? parseFloat(price[1]) : null;
      productsQuery.greaterThanOrEqualTo('price', min);
      if (max) productsQuery.lessThanOrEqualTo('price', max);
    }
    
    if (filters.class && filters.class != 'all') {
      var classQuery = new Parse.Query(Classification);
      classQuery.equalTo('name', filters.class);
      productsQuery.matchesQuery('classification', classQuery);
    }
*/
    
  }
  
  ordersQuery = getOrderSort(ordersQuery, currentSort);
  ordersQuery.limit(ORDERS_PER_PAGE);
  ordersQuery.include('orderProducts');
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  ordersQuery.count().then(function(count) {
    totalOrders = count;
    totalPages = Math.ceil(totalOrders / ORDERS_PER_PAGE);
    ordersQuery.skip((currentPage - 1) * ORDERS_PER_PAGE);
    return ordersQuery.find({useMasterKey:true});
    
  }).then(function(orders) {
	  response.success({orders: orders, totalPages: totalPages});
	  
  }, function(error) {
	  response.error("Unable to get orders: " + error.message);
	  
  });
});

Parse.Cloud.define("loadOrder", function(request, response) {
  var order = request.params.order;
  var added = false;
  
  var orderQuery = new Parse.Query(Order);
  orderQuery.equalTo('orderId', parseInt(order.id));
  orderQuery.first().then(function(orderResult) {
    if (orderResult) {
      console.log('Order ' + orderResult.get('orderId') + ' exists.');
      return createOrderObject(order, orderResult).save(null, {useMasterKey: true});
    } else {
      console.log('Order ' + order.id + ' is new.');
      added = true;
      return createOrderObject(order).save(null, {useMasterKey: true});
    }
    
  }).then(function(orderObject) {
    response.success({added: added});
    
  }, function(error) {
    response.error("Error saving order: " + error.message);
		
	});
});

Parse.Cloud.define("loadOrderProducts", function(request, response) {
  var bcOrder = request.params.order;
  var orderObj;
  var orderProducts = [];
  var totalProductsAdded = 0;
  var orderAdded = false;
  
  var orderQuery = new Parse.Query(Order);
  orderQuery.equalTo('orderId', parseInt(bcOrder.id));
  orderQuery.first().then(function(orderResult) {
    if (orderResult) {
      console.log('Order ' + orderResult.get('orderId') + ' exists.');
      return createOrderObject(bcOrder, orderResult).save(null, {useMasterKey: true});
    } else {
      console.log('Order ' + bcOrder.id + ' is new.');
      orderAdded = true;
      return createOrderObject(bcOrder).save(null, {useMasterKey: true});
    }
    
  }).then(function(result) {
    orderObj = result;
    var request = '/orders/' + bcOrder.id + '/products?limit=' + BIGCOMMERCE_BATCH_SIZE;
    return bigCommerce.get(request);
    
  }).then(function(bcOrderProducts) {
//     console.log(bcOrderProducts);
    
    var promise = Parse.Promise.as();
		_.each(bcOrderProducts, function(orderProduct) {
  		promise = promise.then(function() {
    		console.log('process orderProduct id: ' + orderProduct.id);
        var orderProductQuery = new Parse.Query(OrderProduct);
        orderProductQuery.equalTo('orderProductId', parseInt(orderProduct.id));
    		return orderProductQuery.first()
    		
  		}).then(function(orderProductResult) {
        if (orderProductResult) {
          console.log('OrderProduct ' + orderProductResult.get('orderProductId') + ' exists.');
          return createOrderProductObject(orderProduct, orderObj, orderProductResult).save(null, {useMasterKey: true});
        } else {
          console.log('OrderProduct ' + orderProduct.id + ' is new.');
          totalProductsAdded++;
          return createOrderProductObject(orderProduct, orderObj).save(null, {useMasterKey: true});
        }
    		
  		}).then(function(orderProductObject) {
    		return orderProducts.push(orderProductObject);
  		});
    });
    return promise;
    
  }).then(function(result) {
    console.log(orderObj);
    orderObj.set('orderProducts', orderProducts);
    orderObj.save(null, {useMasterKey: true});
    
  }).then(function(orderObj) {
    response.success({added: orderAdded});
    
  }, function(error) {
    response.error("Error saving order: " + error.message);
		
	});
});

/////////////////////////
//  BEFORE SAVE        //
/////////////////////////

Parse.Cloud.beforeSave("OrderProduct", function(request, response) {
  var orderProduct = request.object;
  var productOptions =  orderProduct.get('product_options');
  console.log('product has ' + productOptions.length + ' options');
  
  // Match the OrderProduct to a ProductVariant and save as a pointer
/*
  var variantQuery = new Parse.Query(ProductVariant);
  variantQuery.equalTo('variantId', variantId);
  variantQuery.first().then(function(variantResult) {
    if (variantResult) {
      console.log('Variant ' + variantResult.get('variantId') + ' exists.');
      isNew = false;
      return createProductVariantObject(product, variantId, null, variantResult).save(null, {useMasterKey: true});
    } else {
      console.log('Variant ' + variantId + ' is new.');
      totalVariantsAdded++;
      return createProductVariantObject(product, variantId, null).save(null, {useMasterKey: true});
    }
*/
  response.success();
});


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

var getOrderSort = function(productsQuery, currentSort) {
  switch (currentSort) {
    case 'date-added-desc':
      productsQuery.descending("date_created");
      break;
    case 'date-added-asc':
      productsQuery.ascending("date_created");
      break;
    case 'total-desc':
      productsQuery.descending("total");
      break;
    case 'total-asc':
      productsQuery.ascending("total");
      break;
    default:
      productsQuery.descending("date_created");
      break;
  }
  return productsQuery;
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
  
//   orderProduct.set('order', order);
  
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





