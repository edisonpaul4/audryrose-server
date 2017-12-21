// var bugsnag = require("bugsnag");
// bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");

// controllers
const { ReturnsController } = require('./returns/returns.controller');

// models
const { ReturnsModel } = require('./returns/returns.model');
const { OrdersModel } = require('./orders/orders.model');
const { CustomersModel } = require('./customers/customers.model');
const { ProductsModel } = require('./products/products.model');

Parse.Cloud.define('createReturn', function(req, res) {
  const { 
    orderId,
    orderProductId,
    customerId,
    productId,
    productVariantId,
    returnReasonId
  } = req.params;

  if (typeof orderId === 'undefined' 
      || typeof orderProductId === 'undefined' 
      || typeof customerId === 'undefined' 
      || typeof productId === 'undefined' 
      || typeof productVariantId === 'undefined' 
      || typeof returnReasonId === 'undefined') {
    res.error('missing parameters');
  }

  Promise.all([
    OrdersModel.getOrdersByFilters({equal: [
      { key: 'orderId', value: orderId }
    ]}).first(),
    OrdersModel.getOrderProductsByFilters({ equal: [
      { key: 'orderProductId', value: orderProductId }
    ]}).first(),
    CustomersModel.getCustomersByFilters({ equal: [
      { key: 'customerId', value: customerId }
    ]}).first(),
    ProductsModel.getProductsByFilters({ equal: [
      { key: 'productId', value: productId }
    ]}).first(),
    ProductsModel.getProductsVariantsByFilters({ equal: [
      { key: 'variantId', value: productVariantId }
    ]}).first(),
  ])
    .then(results => ReturnsController.createOrderProductReturn({
      order: results[0],
      orderProduct: results[1],
      customer: results[2],
      product: results[3],
      productVariant: results[4],
      returnReasonId
    }))
    .then(data => res.success(data))
    .catch(error => res.error(error));
});