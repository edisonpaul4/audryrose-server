const { BaseModel } = require('../database/base.model');
const { ProductsModel } = require('../products/products.model');

exports.OrdersModel = new class OrdersModel extends BaseModel{
  constructor() {
    super();
    this.Orders = Parse.Object.extend('Order');
  }

  /**
   * @returns {Promise} - Array of objects
   * @param {Object} params - base query params
   */
  getOrdersByFilters(params) {
    var ordersQuery = new Parse.Query(this.Orders);
    return this.searchDatabase(params, ordersQuery);
  } // END getOrdersByFilters

  /**
   * 
   * @param {ParseObject} orderObject 
   * @param {String} message 
   */
  setInternalNotes(orderObject, message) {
    console.log('OrdersModel::setInternalNote')
    if (typeof message !== 'string')
      return Promise.reject({ message: 'Staff\'s note must be a string' });
    
    return orderObject.set('internalNotes', message)
      .save();
  } // END setStaffNote
  
  /**
   * 
   * @param {ParseObject} orderObject 
   * @param {String} message 
   */
  setDesignerNotes(orderObject, message) {
    console.log('OrdersModel::setDesignerNote');
    if (typeof message !== 'string')
      return Promise.reject({ message: 'Designer\'s note must be a string' });

    return orderObject.set('designerNotes', message)
      .save();
  } // END setDesignerNote

  /**
   *
   * @returns {Promise} - Array of objects
   * @param {Object} params - base query params
   */
  getCustomerOrdersForSendEmails() {
    console.log('OrdersModel::getCustomerOrdersForSendEmails');

    const getProductsObjects = orderObject => {
      return Promise.all(orderObject.orderProducts.map(orderProduct => {
        return Promise.all(orderProduct.variants.map(variant => {
          const filters = { equal: [{ key: 'productId', value: variant.productId }] };
          return ProductsModel.getProductsByFilters(filters)
            .first()
            .then(product => {
              variant.product = product.toJSON();
              return variant;
            });
        }))
        .then(variants => {
          orderProduct['productVariant'] = variants[0];
          return orderProduct
        })
      }))
      .then(orderProducts => {
        orderObject['orderProducts'] = orderProducts;
        return orderObject;
      })
    };

    const ordersFilters = {
      includes: ['customer', 'orderProducts', 'orderProducts.product_options', 'orderProducts.variants'],
      notEqual: [ { key: 'isEmailSended', value: true } ],
      exists: ['customer'],
      limit: 100
    };

    return this.getOrdersByFilters(ordersFilters)
      .descending('date_created')
      .find()
      .then(ordersObjects => Promise.all(ordersObjects.map(orderObject => getProductsObjects(orderObject.toJSON()))))
  } // END getCustomerOrdersForSendEmails
}
