const { OrdersModel } = require('./orders.model');

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
        .then(orders => resolve(orders))
        .catch(error => reject(error))
    });
  } // END getOrdersForProduct

}