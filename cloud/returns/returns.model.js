var { BaseModel } = require('../database/base.model');

exports.ReturnsModel = new class ReturnsModel extends BaseModel {
  constructor() {
    super();
    this.Return = Parse.Object.extend('Return');
  }

  /**
   * @returns Promise - Array of objects
   * @param base query params
   */
  getReturnsByFilters(params) {
    var returnsQuery = new Parse.Query(this.Return);
    return this.searchDatabase(params, returnsQuery);
  }
}