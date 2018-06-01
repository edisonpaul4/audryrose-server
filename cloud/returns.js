// var bugsnag = require("bugsnag");
// bugsnag.register("a1f0b326d59e82256ebed9521d608bb2");

// controllers
const { ReturnsController } = require('./returns/returns.controller');

// models
const { ReturnsModel } = require('./returns/returns.model');
const { OrdersModel } = require('./orders/orders.model');
const { CustomersModel } = require('./customers/customers.model');
const { ProductsModel } = require('./products/products.model');
const { ShipmentsModel } = require('./shipments/shipments.model');

Parse.Cloud.define('createReturn', function(req, res) {
  const { returnTypeId, products } = req.params;
  if (typeof returnTypeId === 'undefined' || typeof products === 'undefined')
    res.error({ message: 'parameter type or products is missing'});

  const createReturnForProduct = (returnTypeId, {
    orderId,
    orderProductId,
    customerId,
    productId,
    productVariantId,
    options,
    orderShipmentId
  }) => {
    return Promise.all([
      OrdersModel.getOrdersByFilters({
        equal: [{ key: 'orderId', value: orderId }]
      }).first(),
      OrdersModel.getOrderProductsByFilters({
        includes: ['variants', 'variants.designer', 'variants.designer.vendors', 'variants.designer.vendors.vendorOrders', 'returns'],
        equal: [{ key: 'orderProductId', value: orderProductId }]
      }).first(),
      CustomersModel.getCustomersByFilters({
        equal: [{ key: 'customerId', value: customerId }]
      }).first(),
      ProductsModel.getProductsByFilters({
        equal: [{ key: 'productId', value: productId }]
      }).first(),
      ProductsModel.getProductsVariantsByFilters({
        equal: [{ key: 'variantId', value: productVariantId }]
      }).first(),
      ShipmentsModel.getOrderShipmentsByFilters({
        equal: [{ key: 'shipmentId', value: orderShipmentId }]
      }).first(),
    ])
      .then(results => ReturnsController.createOrderProductReturn({
        order: results[0],
        orderProduct: results[1],
        customer: results[2],
        product: results[3],
        productVariant: results[4],
        orderShipment: results[5],
        options,
        returnTypeId
      }));
  }

  return Promise.all(products.map(product => createReturnForProduct(returnTypeId, product)))
    .then(data => res.success(data))
    .catch(error => res.error(error));
});

Parse.Cloud.define('getReturnsWithInformation', function(req, res) {
  return ReturnsController.getReturnsWithInformation()
    .then(data => res.success(data))
    .catch(error => res.error(error));
})

Parse.Cloud.define('checkInReturnedProduct', function(req, res) {
  return ReturnsController.checkInReturnedProduct(req.params.returnId)
    .then(data => res.success(data))
    .catch(error => res.error(error));
})

Parse.Cloud.define('updateReturnStatus', function(req, res) {
  return ReturnsController.updateReturnStatus(req.params.returnId, req.params.returnStatusId)
    .then(data => res.success(data))
    .catch(error => res.error(error));
})

Parse.Cloud.define('returnsForEmails', function(req, res) {
  return ReturnsController.returnsForEmails()
    .then(data => res.success(data))
    .catch(error => res.error(error));
})

Parse.Cloud.define('sendReturnEmail', function(req, res) {
  const { returnId, emailSubject, emailText, emailTo } = req.params;
  return ReturnsController.sendReturnEmail(returnId, emailSubject, emailText, emailTo)
    .then(data => res.success(data))
    .catch(error => res.error(error));
})

Parse.Cloud.define('deleteReturn', function(req, res) {
  const { returnId } = req.params;
  return ReturnsController.deleteReturn(returnId)
    .then(data => res.success(data))
    .catch(error => res.error(error));
})