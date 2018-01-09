const { BaseModel } = require('../database/base.model');

exports.ShipmentsModel = new class ShipmentsModel extends BaseModel {
  constructor() {
    super();
    this.OrderShipment = Parse.Object.extend('OrderShipment');
  }

  /**
   * @returns {Promise} - Array of objects
   * @param {Object} params - base query params
   */
  getOrderShipmentsByFilters(params) {
    var shipmentsQuery = new Parse.Query(this.OrderShipment);
    return this.searchDatabase(params, shipmentsQuery);
  } // END getOrderShipmentsByFilters

  /**
  * @returns {Promise} - Array of objects
  * @param {Object} params - base query params
  */
  getOrderProductsByFilters(params) {
    var orderProductsQuery = new Parse.Query(this.OrderProducts);
    return this.searchDatabase(params, orderProductsQuery);
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

    const findProductId = orderProduct => {
      switch (true) {
        case orderProduct.edited && orderProduct.editedVariants.length > 0:
          return orderProduct.editedVariants[0].productId;

        case typeof orderProduct.variants !== 'undefined' && orderProduct.variants.length > 0:
          return orderProduct.variants[0].productId;

        case typeof orderProduct.product_id !== 'undefined':
          return orderProduct.product_id;
      }
    };

    const findTotalStock = orderProduct => {
      if (orderProduct.variants && orderProduct.variants.length > 0)
        return orderProduct.variants[0].inventoryLevel ? orderProduct.variants[0].inventoryLevel : 0;
      else
        return null;
    };

    const getProductsIds = ordersObject => {
      const productsIds = (() => {
        let ids = [];
        return newId => {
          if (ids.indexOf(newId) === -1 && typeof newId !== 'undefined')
            ids.push(newId);
          return ids;
        }
      })();
      ordersObject.forEach(orderObject => {
        if (typeof orderObject.orderProducts === 'undefined')
          return null;
        orderObject.orderProducts.forEach(orderProduct => {
          productsIds(findProductId(orderProduct));
        });
      });
      return productsIds();
    };

    const getProductsObjects = productsIds => {
      const queries = productsIds.map(id => {
        const filters = { equal: [{ key: 'productId', value: id }] };
        return ProductsModel.getProductsByFilters(filters)
      });
      return Parse.Query.or(...queries)
        .include('classification')
        .include('designer')
        .include('vendor')
        .find()
    };

    const mergeOrdersAndProducts = (orders, products) => {
      return orders.map(order => ({
        ...order,
        orderProducts: order.orderProducts ? order.orderProducts.map(orderProduct => {
          const productId = findProductId(orderProduct);
          const productIndex = products.findIndex(product => product.get('productId') === productId);
          const totalStock = findTotalStock(orderProduct);
          return {
            ...orderProduct,
            vendor: productIndex !== -1 ? products[productIndex].get('vendor') : undefined,
            designer: productIndex !== -1 ? products[productIndex].get('designer') : undefined,
            isActive: productIndex !== -1 ? products[productIndex].get('is_active') : false,
            totalInventory: totalStock !== null ? totalStock : productIndex !== -1 ? products[productIndex].get('total_stock') : 0,
            classificationName: productIndex !== -1 && products[productIndex].get('classification') ? products[productIndex].get('classification').get('name') : 'product',
          };
        }) : []
      }));
    };

    const ordersQuery = this.getOrdersByFilters({
      includes: ['customer', 'orderProducts', 'orderProducts.product_options', 'orderProducts.variants', 'orderProducts.editedVariants', 'orderProducts.awaitingInventory', 'orderProducts.awaitingInventoryVendorOrders', 'orderProducts.awaitingInventoryVendorOrders.vendorOrderVariants'],
      notEqual: [{ key: 'isEmailSended', value: true }],
      exists: ['customer'],
      notExists: ['date_shipped'],
      limit: 100
    });

    return ordersQuery
      .descending('date_created')
      .find()
      .then(all => all.map(current => current.toJSON()))
      .then(orders => {
        return getProductsObjects(getProductsIds(orders))
          .then(products => mergeOrdersAndProducts(orders, products));
      });
  } // END getCustomerOrdersForSendEmails
}
