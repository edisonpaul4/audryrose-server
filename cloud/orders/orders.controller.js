const { OrdersModel } = require('./orders.model');
const { bigCommerce } = require('../gateways/big-commerce');

exports.OrdersController = new class OrdersController {
  constructor(){}

  /**
   * 
   * @param productId<Number>
   * @param filters<Object> - same values that model filters
   */
  getOrdersForProduct(productId, extraFilters = {}){
    return new Promise((resolve, reject) => {
      const filters = {
        contained: [
          { key: 'productIds', value: [parseInt(productId)]},
        ],
        ...extraFilters
      };
      OrdersModel.getOrdersByFilters(filters)
        .find()
        .then(orders => resolve(orders))
        .catch(error => reject(error))
    });
  } // END getOrdersForProduct


  /**
   * 
   * @param {Number} orderId 
   * @param {String} messages 
   */
  updateOrderNotes(orderId, { internalNotes, designerNotes }){
    console.log('OrdersController::updateOrderNotes')
    if(orderId === undefined || orderId === null)
      return Promise.reject({ message: 'You must especify the orderId' });
      
    const filters = {
      equal: [
        { key: 'orderId', value: orderId }
      ]
    };
    return OrdersModel.getOrdersByFilters(filters)
      .first()
      .then(orderObject => Promise.all(
        [OrdersModel.setInternalNotes(orderObject, internalNotes),
        OrdersModel.setDesignerNotes(orderObject, designerNotes)]
      ))
      .then(results => ({ order: results[1].toJSON() }));
  }

}