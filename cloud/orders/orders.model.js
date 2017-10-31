const { BaseModel } = require('../database/base.model');

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
  setStaffNote(orderObject, message) {
    console.log('OrdersModel::setStaffNote')
    if (typeof message !== 'string')
      return Promise.reject({ message: 'Staff\'s note must be a string' });
    
    return orderObject.set('staff_notes', message)
      .save();
  } // END setStaffNote
  
  /**
   * 
   * @param {ParseObject} orderObject 
   * @param {String} message 
   */
  setDesignerNote(orderObject, message) {
    console.log('OrdersModel::setDesignerNote');
    if (typeof message !== 'string')
      return Promise.reject({ message: 'Designer\'s note must be a string' });

    return orderObject.set('designerNotes', message)
      .save();
  } // END setDesignerNote
}
