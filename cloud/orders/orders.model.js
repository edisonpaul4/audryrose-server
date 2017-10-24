var { BaseModel } = require('../database/base.model');

exports.OrdersModel = new class OrdersModel extends BaseModel{
  constructor() {
    super();
    this.Orders = Parse.Object.extend('Order');
  }

  /**
   * @returns Promise - Array of objects
   * @param base query params
   */
  getOrdersByFilters(params) {
    var ordersQuery = new Parse.Query(this.Orders);
    return this.searchDatabase(params, ordersQuery);
  } // END getOrdersByFilters
}