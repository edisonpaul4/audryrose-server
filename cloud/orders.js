var _ = require('underscore');
var moment = require('moment');
var BigCommerce = require('node-bigcommerce');

var Order = Parse.Object.extend('Order');

const PRODUCTS_PER_PAGE = 50;

/////////////////////////
//  CLOUD FUNCTIONS    //
/////////////////////////

Parse.Cloud.define("getOrders", function(request, response) {
  var totalOrders;
  var totalPages;
  var currentPage = (request.params.page) ? parseInt(request.params.page) : 1;
  
  var ordersQuery = new Parse.Query(Order);
  ordersQuery.descending("date_created");
  ordersQuery.limit(PRODUCTS_PER_PAGE);
//   if (request.params.sort && request.params.sort != 'all') recentJobs.equalTo("status", request.params.filter);
  
  ordersQuery.count().then(function(count) {
    totalOrders = count;
    totalPages = Math.ceil(totalOrders / PRODUCTS_PER_PAGE);
    ordersQuery.skip((currentPage - 1) * PRODUCTS_PER_PAGE);
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


/////////////////////////
//  UTILITY FUNCTIONS  //
/////////////////////////

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